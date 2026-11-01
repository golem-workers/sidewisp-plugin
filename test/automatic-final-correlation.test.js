import test from 'node:test';
import assert from 'node:assert/strict';
import {registerOpenClawHooks, createOpenClawUserTaskLifecycle} from '../src/adapters/openclaw/hooks.js';

const envelope = () => ({eventId:'sw_evt_finalfixture0001',installationId:'sw_ins_fixture001',sequence:1,
 occurredAt:'2026-10-09T00:00:00.000Z',observedAt:'2026-10-09T00:00:00.000Z',
 runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'0.2.59'}});
const fact=(type,sessionId,turnId,component,messageId)=>({...envelope(),type,outcome:'success',
 correlation:{sessionId,turnId,messageId},details:{component}});
const setup=()=>{
 const hooks=new Map(),events=[],life=createOpenClawUserTaskLifecycle();
 registerOpenClawHooks({on:(n,h)=>hooks.set(n,h)},{envelopeFactory:envelope,emit:e=>{const accepted=life.process(e);if(accepted)events.push(accepted);}});
 hooks.get('before_dispatch')({messageId:'3737',sessionKey:'s'},{});
 const started=life.process(fact('turn.started','s','inner','agent_lifecycle_start'));events.push(started);
 life.process(fact('turn.completed','s','inner','agent_lifecycle_end'));
 return {hooks,events,life};
};
test('real nested reply_dispatch without runId completes exact inbound work once',async()=>{
 const {hooks,events,life}=setup();let observe;
 const ctx={SessionKey:'s',MessageSid:'3737',get Body(){throw Error('private body');}};
 hooks.get('reply_dispatch')({sessionKey:'s',ctx},{dispatcher:{appendBeforeDeliver:h=>observe=h}});
 // Later input cannot retarget the observer's snapshot.
 ctx.MessageSid='different';
 const payload=Object.freeze({text:'Обычный final: /v1/activity; секреты защищены.',get mediaUrls(){throw Error('private media');}});
 assert.equal(observe(payload,{kind:'final'}),payload);
 observe({text:'Второй фрагмент'},{kind:'final'});
 await new Promise(resolve=>setImmediate(resolve));
 const finals=events.filter(e=>e.type==='turn.completed');assert.equal(finals.length,1);
 assert.equal(finals[0].correlation.sessionId,'s');assert.equal(finals[0].correlation.turnId,'3737');
 assert.equal(finals[0].messagePreview,payload.text);assert.equal(finals[0].details.component,'final_reply');
 assert.equal(life.status().activeRuns,0);
});
test('missing or mismatched identity never completes latest task',async()=>{
 for(const event of [{sessionKey:'s',ctx:{}},{sessionKey:'other',ctx:{MessageSid:'3737'}},
  {sessionKey:'s',ctx:{MessageSid:'unknown'}},{sessionKey:'s',runId:'unknown',ctx:{MessageSid:'3737'}}]){
  const {hooks,events,life}=setup();let observe;
  hooks.get('reply_dispatch')(event,{dispatcher:{appendBeforeDeliver:h=>observe=h}});
  observe({text:'Не должен завершать'},{kind:'final'});await new Promise(r=>setImmediate(r));
  assert.equal(events.filter(e=>e.type==='turn.completed').length,0);assert.equal(life.status().activeRuns,1);
 }
});
test('delivery and nonfinal payloads remain observation only',async()=>{
 const {hooks,events,life}=setup();let observe;
 hooks.get('reply_dispatch')({sessionKey:'s',ctx:{MessageSidFull:'3737',MessageSid:'other'}},{dispatcher:{appendBeforeDeliver:h=>observe=h}});
 const privatePayload={get text(){throw Error('must not read nonfinal');}};
 observe(privatePayload,{kind:'block'});observe(privatePayload,{kind:'tool'});
 hooks.get('message_sent')({content:'Доставлено',success:true,messageId:'out'},{sessionKey:'s'});
 await new Promise(r=>setImmediate(r));
 assert.equal(events.filter(e=>e.type==='turn.completed').length,0);assert.equal(life.status().activeRuns,1);
 observe({text:'Теперь final'},{kind:'final'});await new Promise(r=>setImmediate(r));
 assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
});
test('exact inbound fallback neither starts work nor changes terminal states',()=>{
 for(const terminal of ['turn.cancelled','turn.failed','turn.timeout']){
  const {life}=setup();
  life.process(fact(terminal,'s','inner','agent_lifecycle_end'));
  // Confirm failure through the existing native terminal policy.
  life.flushPending();
  const before=life.status();const final=life.process(fact('turn.completed','s',undefined,'final_reply','unknown'));
  assert.equal(final,null);assert.equal(life.status().activeRuns,before.activeRuns);
 }
 const life=createOpenClawUserTaskLifecycle();
 life.process(fact('message.received','s',undefined,'before_dispatch','m'));
 assert.equal(life.process(fact('turn.completed','s',undefined,'final_reply','m')),null);
 assert.equal(life.status().activeRuns,0);
});
