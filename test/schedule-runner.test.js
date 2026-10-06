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
 assert.equal(output.state,'failed');assert.equal(output.errorCode,'execution_failed');assert.equal(output.resultSummary,null);
 }finally{await rm(stateDir,{recursive:true,force:true});}
});
