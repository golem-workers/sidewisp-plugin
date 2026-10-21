#!/usr/bin/env node
import {saveConnectionReply,sendConnectionDelay} from '../src/auth/connection-notice.js';
import {queuePreparation} from './queue-preparation.mjs';
import {prepareRuntimeCompanion,finalizeRuntimeCompanion} from '../src/auth/runtime-companion.js';
// Run from an extracted, SHA-256-verified release. Public invitation only;
// credentials and approval proof never appear in arguments, logs or output.
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {installUpdateManager} from './install-update-manager.mjs';
import {isRetainedWork} from '../src/update/hot-update.js';
import {coldActivateOpenClaw} from './cold-activate-openclaw.mjs';
import {prepareConnection} from '../src/auth/prepare-connection.js';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
const args=process.argv.slice(2);const options={};
for(let i=0;i<args.length;i++){if(args[i]==='--supervised')options.supervised=true;else if(args[i]==='--preparation-lock')options.locked=true;else if(args[i]==='--enqueue')options.enqueue=true;else if(args[i]==='--update-only')options.updateOnly=true;else if(/^--(archive|sha256|endpoint|request-id|state-dir|expires-at-ms|telegram-target|telegram-account|telegram-thread-id)$/.test(args[i]))options[args[i].slice(2)]=args[++i];else throw new Error('invalid_prepare_argument');}
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const stateDir=options['state-dir'];const endpoint=new URL(options.endpoint);
if(!path.isAbsolute(stateDir??'') || !path.isAbsolute(options.archive??'') || !/^[a-f0-9]{64}$/.test(options.sha256??'')
 || endpoint.protocol!=='https:' || endpoint.origin!==options.endpoint || (!options.updateOnly && !/^sw_pair_[A-Za-z0-9_-]{32}$/.test(options['request-id']??'')))throw new Error('invalid_prepare_input');
if(createHash('sha256').update(readFileSync(options.archive)).digest('hex')!==options.sha256)throw new Error('archive_hash_mismatch');
if(path.resolve(process.env.OPENCLAW_STATE_DIR??'')!==stateDir || !path.isAbsolute(process.env.OPENCLAW_CONFIG_PATH??''))throw new Error('explicit_active_profile_required');
const stateFile=path.join(stateDir,'sidewisp','prepare-status.json');mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o700});
const writeState=s=>{writeFileSync(stateFile+'.tmp',JSON.stringify({...s,targetVersion:version,updatedAt:new Date().toISOString()}),{mode:0o600});renameSync(stateFile+'.tmp',stateFile);};
const run=args=>execFileSync('openclaw',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
const jobFile=path.join(stateDir,'sidewisp','prepare-job.json');
const saveTerminal=status=>{if(options.supervised){const j=JSON.parse(readFileSync(jobFile,'utf8'));writeFileSync(jobFile+'.tmp',JSON.stringify({...j,terminal:status}),{mode:0o600});renameSync(jobFile+'.tmp',jobFile);}};
if(!options.locked){
 const lock=stateFile+(options.enqueue?'.queue-lock':'.kernel-lock');
 const child=spawn('/usr/bin/flock',['--nonblock','--conflict-exit-code','3',lock,process.execPath,...process.execArgv,fileURLToPath(import.meta.url),...args,'--preparation-lock'],{stdio:'inherit'});
 child.once('error',()=>process.exit(3));child.once('exit',code=>process.exit(code??1));
}else if(options.enqueue){
 const result=queuePreparation({stateDir,version,sha256:options.sha256,endpoint:endpoint.origin,args:args.filter(a=>!['--enqueue','--preparation-lock'].includes(a)),script:fileURLToPath(import.meta.url)});
 if(options['telegram-target']&&!options.updateOnly)await saveConnectionReply({stateDir,endpoint:endpoint.origin,requestId:options['request-id'],route:{channel:'telegram',to:options['telegram-target'],accountId:options['telegram-account'],threadId:options['telegram-thread-id']}});
 console.log(JSON.stringify({...result,nextAction:'Finish this setup turn. Independent preparation survives caller timeout; expired consent requires a fresh invitation, never an automatic extension.'}));
}else{
 try{
  const job=options.supervised?JSON.parse(readFileSync(jobFile,'utf8')):null;
  if(job?.terminal)process.exit(0);
  if(options['telegram-target']&&!options.updateOnly)await saveConnectionReply({stateDir,endpoint:endpoint.origin,requestId:options['request-id'],route:{channel:'telegram',to:options['telegram-target'],accountId:options['telegram-account'],threadId:options['telegram-thread-id']}});
  const status=()=>{try{return JSON.parse(run(['gateway','call','sidewisp.status','--params','{}','--json']));}catch(e){if(/unknown method[: ]+sidewisp\.status/i.test(String(e.stderr)+' '+String(e.stdout)))return null;throw e;}};
  const client=createDeviceAuthorizationClient({endpoint:endpoint.origin,stateDir});
  let reported='',reportedAt=0;
  const persist=async s=>{
   writeState({status:s.stage,...s});
   const delayReason=s.reasonCode??s.reason;
   if((s.stage==='blocked'||s.stage==='waiting_for_host_idle')&&delayReason)await sendConnectionDelay({stateDir,endpoint:endpoint.origin,requestId:options['request-id'],reason:delayReason}).catch(()=>{});
   if(options.updateOnly || ['completed','connection_pending','approval_pending'].includes(s.stage))return;
   const key=s.stage+':'+(s.reasonCode??s.reason??'');
   if(key===reported&&Date.now()-reportedAt<30000)return;
   reported=key;reportedAt=Date.now();
   const allowed=['ACTIVE_WORK','HOST_RETAINED_WORK','IDLE_WINDOW_TIMEOUT','host_idle_timeout','fresh_invitation_required','update_failed','collector_not_ready','preparation_failed'];
   const reason=s.reasonCode??s.reason;
   try{await client.reportPreparation({id:options['request-id'],stage:s.stage,...(reason?{reasonCode:allowed.includes(reason)?reason:'preparation_failed'}:{})});}
   catch{writeState({status:s.stage,...s,progressReporting:'unavailable'});}
  };
  const result=await prepareConnection({targetVersion:version,endpoint:endpoint.origin,updateOnly:options.updateOnly,
   resumePreparation:options.supervised, idleDeadlineMs:job?.deadlineMs,
   expiresAtMs:options['expires-at-ms'] === undefined ? undefined : Number(options['expires-at-ms']),
   inspect:status,prepareRuntime:()=>prepareRuntimeCompanion({run,stateDir,configPath:process.env.OPENCLAW_CONFIG_PATH}),finalizeRuntime:prepared=>finalizeRuntimeCompanion({stateDir,prepared}),runtimeNeedsActivation:prepared=>JSON.parse(run(['gateway','status','--no-probe','--json'])).service.runtime.pid===prepared.gatewayPid,persist,
   // Do not wait for collector readiness before configuring a fresh install.
   // Host retained-work refusal stops this attempt; it never permits bypass.
   install:async()=>run(['plugins','install',options.archive,'--force','--accept-capabilities']),
   activate:async()=>{
    run(['config','set','plugins.entries.sidewisp.config.endpoint',endpoint.origin]);
    run(['plugins','reload','sidewisp','--accept-capabilities','--json']);
   },
   coldActivate:()=>coldActivateOpenClaw({run,stateDir,configPath:process.env.OPENCLAW_CONFIG_PATH}),
   upgrade:async()=>{
    await runHelper(s=>persist({stage:'waiting_for_host_idle',reasonCode:s.reasonCode??'ACTIVE_WORK'}));
    const state=JSON.parse(readFileSync(path.join(stateDir,'sidewisp/update-status.json'),'utf8'));
    if(state.status==='deferred')throw Object.assign(new Error('update_deferred'),{reasonCode:state.reasonCode});
    if(state.status==='failed')throw new Error('update_failed');
    if(!['completed','skipped'].includes(state.status))throw new Error('update_not_applied');
   },
   ensureManager:async()=>installUpdateManager({stateDir,endpoint:endpoint.origin,upgrade:true}),
   begin:async()=>{
    return client.begin({id:options['request-id'],runtime:'openclaw'});
   },
  });
  saveTerminal(result.status);console.log(JSON.stringify(result));
 }catch(e){const result={status:'blocked',reason:isRetainedWork(e)?'host_retained_work':/^[a-z_]+$/i.test(e.message)?e.message:'preparation_failed'};writeState(result);saveTerminal(result.reason);console.log(JSON.stringify(result));process.exitCode=1;}
}
async function runHelper(onProgress){
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:version,targetSpec:`git:github.com/golem-workers/sidewisp-plugin@v${version}`,
 sha256:options.sha256,archivePath:options.archive,restartDelaySeconds:30,stateFile:path.join(stateDir,'sidewisp/update-status.json')};
 // Keep the helper outside the Gateway lifetime and project busy admission
 // while it runs. A deferred journal is resumable; a failed one is not retried.
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./openclaw-update-helper.mjs',import.meta.url)),JSON.stringify(d)],{stdio:'ignore'});
  let pending=Promise.resolve();
  const poll=setInterval(()=>{try{const s=JSON.parse(readFileSync(d.stateFile,'utf8'));if(s.targetVersion===version&&s.status==='waiting_for_idle')pending=pending.then(()=>onProgress(s));}catch{}},1000);
  child.once('error',e=>{clearInterval(poll);reject(e);});
  child.once('exit',code=>{clearInterval(poll);pending.then(()=>{if(code===0)return resolve();let state;try{state=JSON.parse(readFileSync(d.stateFile,'utf8'));}catch{}reject(new Error(state?.status==='failed'?'update_failed':'update_interrupted'));},reject);});
 });
}
