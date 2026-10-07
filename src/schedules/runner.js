import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { signBatch } from '../delivery/uploader.js';
import { scheduleFailureSummary } from './diagnostics.js';

// A single durable result outbox; never launch another task until its result is acknowledged.
export function createScheduleRunner({stateDir,endpoint,credentialProvider,runtime,agentId='main',fetchImpl=fetch,now=Date.now,intervalMs=15000,canExecute=()=>true}) {
  const file=path.join(stateDir,'sidewisp','schedule-execution.json');
  let stopped=true,timer=null,running=null;
  const save=async value=>{await mkdir(path.dirname(file),{recursive:true,mode:0o700});await writeFile(`${file}.tmp`,JSON.stringify(value),{mode:0o600});await rename(`${file}.tmp`,file);};
  const load=async()=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
  async function request(credential,operation,payload={}) {
    const body=Buffer.from(JSON.stringify({operation,...payload}));
    const timestamp=String(Math.floor(now()/1000)),nonce=crypto.randomBytes(16).toString('base64url');
    const signature=signBatch({secret:credential.secret,timestamp,nonce,body});
    const response=await fetchImpl(new URL(`/v1/schedule-execution/${operation}`,endpoint),{method:'POST',body,signal:AbortSignal.timeout(10000),headers:{
      'content-type':'application/json',authorization:`Sidewisp ${credential.installationId}:${signature}`,
      'x-sidewisp-algorithm':'hmac-sha256-v1','x-sidewisp-timestamp':timestamp,'x-sidewisp-nonce':nonce}});
    if(!response.ok) throw Object.assign(new Error(`schedule_http_${response.status}`),{status:response.status});
    return response.json();
  }
  async function settle(entry,credential) {
    let ack; try {ack=await request(credential,'result',entry.result);} catch(error) {if(error.status===404){await unlink(file);return;}throw error;}
    if(ack.runId!==entry.job.runId)throw new Error('invalid_schedule_ack');
    await unlink(file);
  }
  async function execute() {
    if (!canExecute()) return; // Keep the service-owned timer, but admit no work before activation.
    const credential=await credentialProvider.current();
    if(credential?.status!=='active')return;
    let entry=await load();
    if(entry && (entry.installationId!==credential.installationId || entry.endpoint!==new URL(endpoint).origin)) {
      // A new binding must never receive or execute the old binding's pending work.
      await rename(file,`${file}.quarantine-${now()}`);entry=null;
    }
    if(entry?.result) return settle(entry,credential);
    const recovered=Boolean(entry);
    if(!entry) {
      const {job}=await request(credential,'poll');
      if(!job)return;
      if(!/^run_[A-Za-z0-9_-]+$/.test(job.runId??'') || !/^sch_[A-Za-z0-9_-]+$/.test(job.scheduleId??'')
        || !['agentTurn','systemEvent'].includes(job.payload?.kind) || typeof job.payload?.summary!=='string'
        || job.payload.summary.length>2000 || job.timeoutMs!==600000) throw new Error('invalid_schedule_job');
      entry={endpoint:new URL(endpoint).origin,installationId:credential.installationId,job,startedAt:now(),sessionKey:`agent:${agentId}:sidewisp:${job.runId}`};
      await save(entry);
    }
    const result={runId:entry.job.runId,scheduleId:entry.job.scheduleId,state:'failed',errorCode:'execution_interrupted',executionRef:null,resultSummary:null};
    let stage='launch',outcome;
    try {
      if(recovered && !entry.runtimeRunId) {
        // Crash in launch/ack window: do not guess whether a side effect happened.
      } else if(entry.job.payload.kind==='systemEvent') {
        if(typeof runtime.system?.enqueueSystemEvent!=='function') {result.state='blocked';result.errorCode='runtime_unsupported';}
        else {
          await runtime.system.enqueueSystemEvent(entry.job.payload.summary,{sessionKey:`agent:${agentId}:main`,contextKey:`sidewisp:${entry.job.runId}`});
          result.state='succeeded';result.errorCode=null;result.resultSummary='System event delivered to the agent session.';
        }
      } else if(!runtime.subagent?.run || !runtime.subagent?.waitForRun) {
        result.state='blocked';result.errorCode='runtime_unsupported';
      } else {
        if(!entry.runtimeRunId) {
          const launched=await runtime.subagent.run({sessionKey:entry.sessionKey,message:entry.job.payload.summary,
            idempotencyKey:entry.job.runId,deliver:false,lane:'cron',lightContext:true});
          entry.runtimeRunId=launched.runId;entry.sessionKey=launched.sessionKey??entry.sessionKey;
          await save(entry);
        }
        result.executionRef=entry.runtimeRunId;
        stage='wait';
        while(!stopped && now()-entry.startedAt<entry.job.timeoutMs) {
          outcome=await runtime.subagent.waitForRun({runId:entry.runtimeRunId,timeoutMs:Math.min(30000,entry.job.timeoutMs-(now()-entry.startedAt))});
          // Retry only an SDK-marked wait transport failure, on the same run.
          // Terminal error text and admission failures never authorize retry.
          if(outcome.status==='ok' || (outcome.status==='error' && outcome.retryableTransportError!==true))break;
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
        if(stopped)return;
        if(outcome?.status==='ok') {
          stage='response';
          result.resultSummary=typeof outcome.terminalReply?.text==='string' ? outcome.terminalReply.text.slice(0,16000) : null;
          if(result.resultSummary===null && runtime.subagent.getSessionMessages) {
            const history=await runtime.subagent.getSessionMessages({sessionKey:entry.sessionKey,limit:10});
            const final=history.messages?.filter(m=>m.role==='assistant').at(-1);
            result.resultSummary=(typeof final?.content==='string'?final.content:(Array.isArray(final?.content)?final.content:[]).filter(c=>c.type==='text').map(c=>c.text).join('\n')).slice(0,16000);
          }
          result.state='succeeded';result.errorCode=null;
        } else if(outcome?.status==='error' && outcome.retryableTransportError!==true) { result.errorCode='execution_failed';result.resultSummary=scheduleFailureSummary(stage,null,outcome); }
        else {
          result.errorCode='execution_timeout';
          await runtime.gateway?.request('chat.abort',{sessionKey:entry.sessionKey,runId:entry.runtimeRunId}).catch(()=>{});
        }
      }
    } catch(error) { result.state='failed';result.errorCode='execution_failed';result.resultSummary=scheduleFailureSummary(stage,error,outcome); }
    entry.result=result;await save(entry);return settle(entry,credential);
  }
  function tick() { if(running)return running;running=execute().finally(()=>{running=null;});return running; }
  function schedule() {if(stopped)return;timer=setTimeout(()=>void tick().catch(()=>{}).finally(schedule),intervalMs);timer.unref?.();}
  return {start(){if(!stopped)return;stopped=false;schedule();},async stop(){stopped=true;clearTimeout(timer);await running?.catch(()=>{});},
    async runOnce(){stopped=false;return tick();}};
}
