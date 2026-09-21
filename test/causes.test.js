import test from 'node:test';
import assert from 'node:assert/strict';
import {CAUSE_CODES,classifyRuntimeCause} from '../src/core/causes.js';
test('254 explicit typed codes are preserved without reading arbitrary error text',()=>{
 assert.equal(CAUSE_CODES.size,254);
 for(const causeCode of CAUSE_CODES)assert.equal(classifyRuntimeCause({causeCode}),causeCode);
 assert.equal(classifyRuntimeCause({message:'ENOSPC private secret'}),null);
 assert.equal(classifyRuntimeCause({code:'ENOSPC'}),'disk_full');
 assert.equal(classifyRuntimeCause({code:'ENOSPC',expected:true}),null);
 assert.equal(classifyRuntimeCause({kind:'provider_error',httpStatus:401}),'provider_auth_failed');
 assert.equal(classifyRuntimeCause({operation:'browser',code:'TARGET_CLOSED'}),'browser_target_stale');
});
test('normalization preserves typed causes and explicit recovery, never infers recovery from success',async()=>{
 const {normalizeRuntimeEvent}=await import('../src/core/normalize.js');
 const envelope={eventId:'sw_evt_fixture0000000001',installationId:'sw_ins_fixture001',sequence:1,occurredAt:'2026-09-21T00:00:00Z',observedAt:'2026-09-21T00:00:00Z',runtime:{version:'1'},source:{kind:'hook',adapterVersion:'1'}};
 for(const causeCode of CAUSE_CODES){
  const event=normalizeRuntimeEvent('openclaw',{kind:'tool_end',outcome:'failure',causeCode},envelope).event;
  assert.equal(event.details.causeCode,causeCode);
 }
 assert.equal(normalizeRuntimeEvent('openclaw',{kind:'tool_end',outcome:'success',causeCode:'disk_full'},envelope).event.details.causeCode,undefined);
 assert.equal(normalizeRuntimeEvent('openclaw',{kind:'tool_end',outcome:'success',causeCode:'disk_full',signalState:'recovered'},envelope).event.details.signalState,'recovered');
});
