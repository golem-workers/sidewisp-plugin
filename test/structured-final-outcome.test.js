import test from 'node:test';
import assert from 'node:assert/strict';
import {registerOpenClawHooks,createOpenClawUserTaskLifecycle,openClawAgentEventInput} from '../src/adapters/openclaw/hooks.js';
import {normalizeRuntimeEvent} from '../src/core/normalize.js';
const key=Symbol.for('openclaw.replyPayloadMetadata');
function fixture({withoutRun=false,persist=()=>true}={}) {
 let sequence=0;const events=[];let observer;
 const envelope=()=>({eventId:'sw_evt_finalregression'+(++sequence),installationId:'sw_ins_regression4398',sequence,occurredAt:'2026-10-12T00:00:00.000Z',observedAt:'2026-10-12T00:00:00.000Z',runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'0.2.67'}});
 const life=createOpenClawUserTaskLifecycle({onDeferred:e=>{if(!persist(e))return false;events.push(e);return true;}});
 const emit=e=>{const result=life.processDetailed(e);if(result.event){if(persist(result.event)){events.push(result.event);life.commit(result.event);}else life.rollback(result.event);}return result;};
 const hooks=new Map();registerOpenClawHooks({on:(n,h)=>hooks.set(n,h)},{envelopeFactory:envelope,emit});
 const ctx={sessionKey:'agent:main:telegram:group:regression',messageId:'inbound',runId:'outer'};
 hooks.get('message_received')({},ctx);hooks.get('before_dispatch')({},ctx);
 const runtime=data=>{const input=openClawAgentEventInput({sessionKey:ctx.sessionKey,runId:'outer',stream:'lifecycle',data});const result=normalizeRuntimeEvent('openclaw',input,envelope());emit(result.event);};runtime({phase:'start'});
 hooks.get('reply_dispatch')({}, {...ctx,...(withoutRun?{runId:undefined}:{}),dispatcher:{appendBeforeDeliver:h=>observer=h}});
 const final=(metadata={},text='This failed ⚠️',isError=true)=>{const payload={text,isError};if(!globalThis[key])globalThis[key]=new WeakMap();globalThis[key].set(payload,metadata);assert.equal(observer(payload,{kind:'final'}),payload);};
 return {events,life,runtime,final,terminals:()=>events.filter(e=>['turn.completed','turn.failed','turn.timeout','turn.cancelled'].includes(e.type))};
}
for(const [name,data,type] of [
 ['provider',{phase:'error',endedAt:1,error:'raw provider response'},'turn.failed'],
 ['timeout',{phase:'end',stopReason:'timeout',aborted:true},'turn.timeout'],
 ['cancel',{phase:'end',stopReason:'aborted',aborted:true},'turn.cancelled'],
])for(const first of ['runtime','dispatch'])test(`${name}: ${first} first, one structured terminal, late duplicate ignored`,async()=>{
 const f=fixture();if(first==='runtime')f.runtime(data);f.final({terminalProviderError:true});if(first==='dispatch')f.runtime(data);await f.life.flushPending();f.final({terminalProviderError:true});f.runtime(data);await f.life.flushPending();assert.equal(f.terminals().length,1);assert.equal(f.terminals()[0].type,type);assert.equal(f.terminals()[0].messagePreview?.includes('raw provider response'),false);assert.equal(f.life.activeWork().length,0);
});
test('error final without run ID resolves exact captured inbound identity',async()=>{const f=fixture({withoutRun:true});f.runtime({phase:'error',endedAt:1});f.final({terminalProviderError:true});await f.life.flushPending();assert.equal(f.terminals()[0].type,'turn.failed');assert.equal(f.terminals()[0].correlation.turnId,'inbound');});
test('error final without native lifecycle falls back to failure, never success',async()=>{const f=fixture();f.final({terminalProviderError:true});assert.equal(f.terminals().length,0);await f.life.flushPending();assert.equal(f.terminals()[0].type,'turn.failed');});
test('successful native turn with tool warning remains completed despite isError and wording',async()=>{const f=fixture();f.runtime({phase:'end',stopReason:'end_turn',aborted:false,livenessState:'working'});f.final({toolErrorWarning:{toolName:'sessions_yield'}},'⚠️ Yield failed');await f.life.flushPending();assert.equal(f.terminals().length,1);assert.equal(f.terminals()[0].type,'turn.completed');assert.equal(f.terminals()[0].messagePreview,'⚠️ Yield failed');});
test('tool warning cannot overwrite structured abandoned native result',async()=>{const f=fixture();f.runtime({phase:'end',stopReason:'stop',livenessState:'abandoned'});f.final({toolErrorWarning:{toolName:'exec'}});await f.life.flushPending();assert.equal(f.terminals()[0].type,'turn.failed');});
test('success after retry clears intermediate error before tool warning final',async()=>{const f=fixture();f.runtime({phase:'error',endedAt:1});f.runtime({phase:'start'});f.runtime({phase:'end',stopReason:'stop'});f.final({toolErrorWarning:{toolName:'exec'}});await f.life.flushPending();assert.equal(f.terminals().length,1);assert.equal(f.terminals()[0].type,'turn.completed');});
test('isError alone and warning text do not classify whole-turn failure',async()=>{const f=fixture();f.runtime({phase:'end',stopReason:'stop'});f.final({},'⚠️ terminalProviderError failed',true);await f.life.flushPending();assert.equal(f.terminals()[0].type,'turn.completed');});
test('negative completion rollback retains native subtype and persists once',async()=>{let writable=true;const f=fixture({persist:()=>writable});f.runtime({phase:'end',stopReason:'timeout',aborted:true});writable=false;f.final({terminalProviderError:true});assert.equal(f.terminals().length,0);assert.equal(f.life.activeWork().length,1);writable=true;await f.life.flushPending();assert.equal(f.terminals().length,1);assert.equal(f.terminals()[0].type,'turn.timeout');});
for(const data of [{phase:'end',stopReason:'timeout',aborted:true},{phase:'error',timeoutPhase:'provider'},{phase:'end',status:'timed_out'}])test(`native timeout metadata wins over abort: ${JSON.stringify(data)}`,()=>{assert.equal(openClawAgentEventInput({stream:'lifecycle',data}).outcome,'timeout');});
test('gateway restart remains continuation, not a timeout or cancellation',()=>{assert.equal(openClawAgentEventInput({stream:'lifecycle',data:{phase:'error',aborted:true,timeoutPhase:'gateway_draining',stopReason:'restart'}}).status,'continuation-pending');});

for(const [data,type] of [[{phase:'end',stopReason:'stop'},'turn.completed'],[{phase:'end',livenessState:'abandoned'},'turn.failed']])test(`warning-first awaits native result: ${type}`,async()=>{const f=fixture();f.final({toolErrorWarning:{toolName:'exec'}},'⚠️ Exec failed');assert.equal(f.terminals().length,0);f.runtime(data);await f.life.flushPending();assert.equal(f.terminals().length,1);assert.equal(f.terminals()[0].type,type);});
test('warning without execution result cannot manufacture completion',async()=>{const f=fixture();f.final({toolErrorWarning:{toolName:'exec'}});await f.life.flushPending();assert.equal(f.terminals().length,0);assert.equal(f.life.activeWork().length,1);});
