import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{openClawAgentEventInput}from'../src/adapters/openclaw/hooks.js';import{stableOpenClawEventId}from'../src/adapters/openclaw/recovery.js';import{normalizeRuntimeEvent}from'../src/core/normalize.js';import{openSpool}from'../src/delivery/spool.js';
test('native approval item boundaries survive real spool alongside exec receipts and late repeats',async()=>{
 const root=await mkdtemp(join(tmpdir(),'approval-identity-'));let spool;
 try{
  const base={runId:'r',sessionKey:'agent:main:telegram:group:s'},call='exec_call',itemId='command:'+call;let seq=0;
  const convert=(stream,data)=>{const input=openClawAgentEventInput({...base,stream,data});return normalizeRuntimeEvent('openclaw',input,{eventId:stableOpenClawEventId(input),installationId:'sw_ins_local',sequence:++seq,occurredAt:new Date().toISOString(),observedAt:new Date().toISOString(),runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'candidate'}}).event;};
  const ordinaryStart=convert('tool',{phase:'start',name:'exec',toolCallId:call});
  const ordinaryReceipt=convert('tool',{phase:'result',name:'exec',toolCallId:call,result:{details:{status:'approval-pending'}}});
  const wait=convert('approval',{phase:'requested',status:'pending',itemId,toolCallId:call,approvalId:'approval-one'});
  const resume=convert('approval',{phase:'resolved',status:'denied',itemId,toolCallId:call});
  assert.equal(wait.correlation.toolCallId,itemId);assert.equal(resume.correlation.toolCallId,itemId);
  assert.notEqual(wait.eventId,ordinaryStart.eventId);assert.notEqual(resume.eventId,ordinaryReceipt.eventId);
  spool=await openSpool({file:join(root,'spool.sqlite')});spool.enqueueSourceBatch('native','1',[ordinaryStart,ordinaryReceipt,wait,resume]);spool.enqueueSourceBatch('native','2',[wait,resume]);
  const rows=spool.pending(10).map(r=>r.event);assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.details.operation==='user_approval'&&r.type==='tool.started').length,1);assert.equal(rows.filter(r=>r.details.operation==='user_approval'&&r.type==='tool.cancelled').length,1);
 }finally{await spool?.close();await rm(root,{recursive:true,force:true});}
});
