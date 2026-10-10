import test from 'node:test';
import assert from 'node:assert/strict';
import { registerOpenClawHooks, openClawAgentEventInput, createOpenClawUserTaskLifecycle } from '../src/adapters/openclaw/hooks.js';
import { normalizeRuntimeEvent } from '../src/core/normalize.js';
const session = 'agent:main:telegram:group:fixture';
const envelope = () => ({eventId:'sw_evt_progressfixture001', installationId:'sw_ins_fixture001', sequence:1,
 occurredAt:'2026-10-07T00:00:00.000Z',observedAt:'2026-10-07T00:00:00.000Z',runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'0.2.46'}});
test('Telegram preview remains eligible with the complete set of Sidewisp telemetry hooks', async () => {
 const hooks=new Map(), events=[];
 registerOpenClawHooks({on:(name,handler)=>hooks.set(name,handler)},{emit:async event=>events.push(event),envelopeFactory:envelope});
 // This is the installed OpenClaw Telegram preview admission predicate.
 const previewAllowed = !hooks.has('reply_payload_sending') && !hooks.has('message_sending');
 assert.equal(previewAllowed,true);
 let observe;
 const dispatcher={appendBeforeDeliver(callback){observe=callback;}};
 assert.equal(hooks.get('reply_dispatch')({sessionKey:session,runId:'outer'},{dispatcher}),undefined);
 const payload=Object.freeze({get text(){throw Error('private text read');},get mediaUrls(){throw Error('private media read');}});
 assert.equal(observe(payload,{kind:'tool'}),payload);
 assert.equal(observe(payload,{kind:'block'}),payload);
 assert.equal(events.length,0);
 assert.equal(observe(payload,{kind:'final'}),payload);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events.map(x=>[x.type,x.correlation.turnId]),[['turn.completed','outer']]);
});
test('completed commentary emits metadata only, ignoring deltas, reasoning, tools and final answer', () => {
 const data={kind:'preamble',phase:'end',itemId:'commentary-1',get progressText(){throw Error('private text read');}};
 const input=openClawAgentEventInput({stream:'item',runId:'inner',sessionKey:session,data});
 const event=normalizeRuntimeEvent('openclaw',input,envelope()).event;
 assert.equal(event.type,'turn.progress');assert.equal(event.details.component,'commentary');
 assert.equal(JSON.stringify(event).includes('private'),false);
 const base={kind:'preamble',phase:'end',itemId:'commentary-1'};
 for(const next of [{...base,phase:'update'},{...base,kind:'analysis'},{...base,kind:'tool'},{...base,itemId:undefined}]) {
  assert.equal(openClawAgentEventInput({stream:'item',data:next}),null);
 }
 assert.equal(openClawAgentEventInput({stream:'assistant',data:{completedText:'final'}}),null);
});
test('progress retains one work identity through internal runs and cannot start or finish a task', () => {
 const life=createOpenClawUserTaskLifecycle();
 const fact=(type,run,details={},messageId)=>({...envelope(),type,outcome:'info',correlation:{sessionId:session,turnId:run,...(messageId?{messageId}:{})},details});
 assert.equal(life.process(fact('turn.progress','unknown')),null);
 life.process(fact('message.received','outer',{component:'before_dispatch'},'inbound-1'));
 const start=life.process(fact('turn.started','inner'));
 const progress=life.process(fact('turn.progress','inner',{component:'commentary'}));
 assert.equal(start.correlation.turnId,'inbound-1');assert.equal(progress.correlation.turnId,start.correlation.turnId);
 assert.equal(life.status().activeRuns,1);
 life.process(fact('turn.completed','inner',{component:'agent_lifecycle_end'}));
 assert.equal(life.status().awaitingFinals,1);
 life.process(fact('turn.progress','inner',{component:'commentary'}));
 assert.equal(life.status().awaitingFinals,0);
 assert.equal(life.status().activeRuns,1);
 assert.equal(life.process(fact('turn.completed','outer',{component:'final_reply'})).type,'turn.completed');
 assert.equal(life.process(fact('turn.progress','inner')),null);
});
test('explicit source message tool progress/final is observed without reading any content', async () => {
 const hooks=new Map(),events=[];
 registerOpenClawHooks({on:(name,handler)=>hooks.set(name,handler)},{emit:async event=>events.push(event),envelopeFactory:envelope});
 const handler=hooks.get('after_tool_call');
 const params={action:'send',final:false,get message(){throw Error('private message read');},get attachments(){throw Error('private attachments read');}};
 const result={details:{ok:true,sourceReplyRoute:'current-source'},get content(){throw Error('private result read');}};
 await handler({toolName:'message',params,result,toolCallId:'tool-1',runId:'run'}, {sessionKey:session});
 params.final=true;
 await handler({toolName:'message',params,result,toolCallId:'tool-2',runId:'run'}, {sessionKey:session});
 assert.deepEqual(events.map(x=>x.type),['turn.progress','turn.completed']);
 for(const details of [{ok:false,sourceReplyRoute:'current-source'},{ok:true,sourceReplyRoute:'elsewhere'},{ok:true,sourceReplyRoute:'current-source',partial:true},{ok:true,sourceReplyRoute:'current-source',dryRun:true}]) {
  await handler({toolName:'message',params,result:{details}}, {sessionKey:session});
 }
 assert.equal(events.length,2);
});
test('missing/throwing dispatcher observer never takes over or breaks a reply', () => {
 const hooks=new Map();
 registerOpenClawHooks({on:(name,handler)=>hooks.set(name,handler)},{emit:async()=>{},envelopeFactory:envelope});
 assert.doesNotThrow(()=>hooks.get('reply_dispatch')({},{}));
 assert.doesNotThrow(()=>hooks.get('reply_dispatch')({},{dispatcher:{appendBeforeDeliver(){throw Error('unavailable');}}}));
});
test('wait and resume belong to the same user work as start, progress and final', () => {
 const life=createOpenClawUserTaskLifecycle();
 const fact=(type,run,details={},messageId)=>({...envelope(),type,outcome:'info',correlation:{sessionId:session,turnId:run,...(messageId?{messageId}:{})},details});
 life.process(fact('message.received','outer',{component:'before_dispatch'},'inbound'));
 const rows=[life.process(fact('turn.started','inner')),
  life.process(fact('turn.progress','inner',{component:'commentary'})),
  life.process(fact('tool.started','inner',{operation:'user_approval'})),
  life.process(fact('tool.completed','inner',{operation:'user_approval'})),
  life.process(fact('turn.completed','outer',{component:'final_reply'}))];
 assert.ok(rows.every(row=>row.correlation.turnId==='inbound'));
});
