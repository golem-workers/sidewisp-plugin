import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createScheduleRunner} from '../src/schedules/runner.js';
const job={runId:'run_test_1',scheduleId:'sch_test_1',payload:{kind:'agentTurn',summary:'Report the current status'},timeoutMs:600000};
test('executes once, retains failed result delivery across restart, and returns actual response',async()=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sidewisp-schedule-'));
 let calls=0,results=0,fail=true;
 const input={stateDir,endpoint:'https://sidewisp.test',credentialProvider:{current:async()=>({installationId:'ins_test',secret:'test',status:'active'})},
 runtime:{subagent:{run:async()=>{calls++;return {runId:'actual-run'};},waitForRun:async()=>({status:'ok',terminalReply:{text:'Verified report'}})}},
 fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);if(body.operation==='poll')return Response.json({job});results++;if(fail)throw new Error('offline');return Response.json({runId:job.runId,state:'succeeded'});}};
 try {
  await assert.rejects(createScheduleRunner(input).runOnce());assert.equal(calls,1);
  fail=false;await createScheduleRunner(input).runOnce();assert.equal(calls,1);assert.equal(results,2);
 }finally{await rm(stateDir,{recursive:true,force:true});}
});
test('runtime rejection is reported as failure, never success',async()=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sidewisp-schedule-'));let output;
 try {await createScheduleRunner({stateDir,endpoint:'https://sidewisp.test',credentialProvider:{current:async()=>({installationId:'ins_test',secret:'test',status:'active'})},
 runtime:{subagent:{run:async()=>{throw new Error('denied');},waitForRun:async()=>{throw new Error('unexpected');}}},
 fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);if(body.operation==='poll')return Response.json({job});output=body;return Response.json({runId:job.runId,state:'failed'});}}).runOnce();
 assert.equal(output.state,'failed');assert.equal(output.errorCode,'execution_failed');assert.equal(JSON.parse(output.resultSummary).stage,'launch');assert.equal(output.resultSummary.includes('denied'),false);
 }finally{await rm(stateDir,{recursive:true,force:true});}
});

async function exerciseRuntime(subagent,{now,job:inputJob=job}={}) {
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sidewisp-schedule-'));let output;
 try {
 await createScheduleRunner({stateDir,endpoint:'https://sidewisp.test',credentialProvider:{current:async()=>({installationId:'ins_test',secret:'test',status:'active'})},runtime:{subagent},...(now?{now}:{}),
 fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);if(body.operation==='poll')return Response.json({job:inputJob});output=body;return Response.json({runId:inputJob.runId,state:body.state});}}).runOnce();
 return output;
 }finally{await rm(stateDir,{recursive:true,force:true});}
}
test('an SDK-marked wait transport failure retries the same accepted run, not the model task',async()=>{
 let launches=0,waits=0;
 const output=await exerciseRuntime({run:async()=>{launches++;return {runId:'native-one'};},waitForRun:async({runId})=>{assert.equal(runId,'native-one');return ++waits===1?{status:'error',retryableTransportError:true,error:'network failure with secret'}:{status:'ok',terminalReply:{text:'Verified reply'}};}});
 assert.equal(launches,1);assert.equal(waits,2);assert.equal(output.state,'succeeded');assert.equal(output.resultSummary,'Verified reply');
});
test('terminal native failure preserves safe diagnosis without error text, credentials or false success',async()=>{
 let waits=0;
 const output=await exerciseRuntime({run:async()=>({runId:'native-one'}),waitForRun:async()=>{waits++;return {status:'error',error:'No route-compatible authentication source is configured for openai. secret=private-key',terminalReply:{text:'private transcript'}};}});
 assert.equal(waits,1);assert.equal(output.state,'failed');assert.equal(output.executionRef,'native-one');assert.equal(JSON.parse(output.resultSummary).reason,'auth_route_unavailable');
 assert.equal(JSON.parse(output.resultSummary).terminalReplyPresent,true);assert.doesNotMatch(JSON.stringify(output),/private-key|private transcript|openai/);
});
test('a legacy completed error is diagnosed, never promoted to success without a successful wait',async()=>{
 const output=await exerciseRuntime({run:async()=>({runId:'native-one'}),waitForRun:async()=>({status:'error',error:'completed',terminalReply:{text:'some text'}})});
 assert.equal(output.state,'failed');assert.equal(JSON.parse(output.resultSummary).reason,'terminal_status_mismatch');
});
test('response retrieval failure cannot produce a succeeded result with an error code',async()=>{
 const output=await exerciseRuntime({run:async()=>({runId:'native-one'}),waitForRun:async()=>({status:'ok'}),getSessionMessages:async()=>{throw Object.assign(new Error('private provider output'),{code:'POLICY_DENIED'});}});
 assert.equal(output.state,'failed');assert.equal(output.errorCode,'execution_failed');assert.equal(JSON.parse(output.resultSummary).stage,'response');assert.equal(JSON.parse(output.resultSummary).causeCode,'policy_denied');assert.doesNotMatch(output.resultSummary,/private provider/);
});
test('transport wait recovery remains bounded and aborts once at the original task deadline',async()=>{
 let time=0,waits=0,launches=0;
 const output=await exerciseRuntime({run:async()=>{launches++;return {runId:'native-one'};},waitForRun:async()=>{waits++;time=600001;return {status:'error',retryableTransportError:true};}},{now:()=>time});
 assert.equal(launches,1);assert.equal(waits,1);assert.equal(output.state,'failed');assert.equal(output.errorCode,'execution_timeout');
});
