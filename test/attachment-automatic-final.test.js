import test from 'node:test';
import assert from 'node:assert/strict';
import {registerOpenClawHooks, createOpenClawUserTaskLifecycle} from '../src/adapters/openclaw/hooks.js';

const envelope=()=>({eventId:'sw_evt_filefinalfixture0001',installationId:'sw_ins_fixture001',sequence:1,
 occurredAt:'2026-10-09T00:00:00.000Z',observedAt:'2026-10-09T00:00:00.000Z',
 runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'0.2.61'}});
const setup=()=>{
 const hooks=new Map(),events=[],life=createOpenClawUserTaskLifecycle();
 registerOpenClawHooks({on:(n,h)=>hooks.set(n,h)},{envelopeFactory:envelope,emit:e=>{const accepted=life.process(e);if(accepted)events.push(accepted);}});
 hooks.get('before_dispatch')({messageId:'3758',sessionKey:'s'},{});
 const started=life.process({...envelope(),type:'turn.started',correlation:{sessionId:'s',turnId:'inner'},details:{component:'agent_lifecycle_start'}});
 events.push(started);
 let observer;hooks.get('reply_dispatch')({sessionKey:'s',ctx:{MessageSid:'3758'}},{dispatcher:{appendBeforeDeliver:h=>observer=h}});
 return {hooks,events,life,observer};
};
const receipt={details:{ok:true,sourceReplyRoute:'current-source'}};
const invoke=(hooks,params)=>hooks.get('after_tool_call')({toolName:'message',params,result:receipt},{sessionKey:'s',runId:'inner',toolCallId:'send-file'});
const settle=()=>new Promise(r=>setImmediate(r));
const privateFields={get attachments(){throw Error('private attachment read');},get media(){throw Error('private media read');},get caption(){throw Error('private caption read');},get target(){throw Error('private target read');}};
const paramsWithPrivateFields=message=>Object.defineProperties({action:'send',message},Object.getOwnPropertyDescriptors(privateFields));

test('implicit textless file send stays open until exact automatic final, without duplicates',async()=>{
 for(const message of [undefined,null,'',' \n\t ',42]){
  const {hooks,events,life,observer}=setup();
  invoke(hooks,paramsWithPrivateFields(message));await settle();
  const progress=events.filter(e=>e.type==='turn.progress');assert.equal(progress.length,1);
  assert.equal(Object.hasOwn(progress[0],'messagePreview'),false);
  assert.equal(events.filter(e=>e.type==='turn.completed').length,0);assert.equal(life.status().activeRuns,1);
  hooks.get('message_sent')({messageId:'file',success:true},{sessionKey:'s'});await settle();
  assert.equal(events.filter(e=>e.type==='turn.completed').length,0);
  const payload=Object.freeze({text:'Готово — отправил `random-30-lines.md`, ровно 30 случайных строк.'});
  assert.equal(observer(payload,{kind:'final'}),payload);observer(payload,{kind:'final'});await settle();
  const finals=events.filter(e=>e.type==='turn.completed');assert.equal(finals.length,1);
  assert.equal(finals[0].correlation.turnId,'3758');assert.equal(finals[0].correlation.turnId,progress[0].correlation.turnId);
  assert.equal(finals[0].messagePreview,payload.text);assert.equal(finals[0].details.component,'final_reply');
  assert.equal(life.status().activeRuns,0);
 }
});

test('explicit file finals and legacy implicit text finals retain terminal semantics',async()=>{
 for(const params of [{action:'send',final:true},{action:'send',message:'Файл отправлен'},{action:'send',message:'password=not-a-real-value'}]){
  const {hooks,events,life,observer}=setup();invoke(hooks,params);await settle();
  const finals=events.filter(e=>e.type==='turn.completed');assert.equal(finals.length,1);assert.equal(life.status().activeRuns,0);
  if(params.message==='Файл отправлен')assert.equal(finals[0].messagePreview,params.message);
  else assert.equal(Object.hasOwn(finals[0],'messagePreview'),false);
  observer({text:'Поздний автоматический final'},{kind:'final'});await settle();assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
 }
});

test('unreadable implicit text fails open for work and closed for preview',async()=>{
 const {hooks,events,life,observer}=setup();invoke(hooks,{action:'send',get message(){throw Error('unreadable text');}});await settle();
 assert.equal(events.filter(e=>e.type==='turn.completed').length,0);assert.equal(life.status().activeRuns,1);
 observer({text:'Bearer not-a-real-secret'},{kind:'final'});await settle();
 const finals=events.filter(e=>e.type==='turn.completed');assert.equal(finals.length,1);assert.equal(Object.hasOwn(finals[0],'messagePreview'),false);
});
