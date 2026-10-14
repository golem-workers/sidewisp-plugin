import test from 'node:test';
import assert from 'node:assert/strict';
import {registerOpenClawHooks,createOpenClawUserTaskLifecycle} from '../src/adapters/openclaw/hooks.js';
async function observe(params,receipt={ok:true,sourceReplyRoute:'current-source'}) {
 const handlers=new Map(),events=[],life=createOpenClawUserTaskLifecycle();
 let n=0;
 registerOpenClawHooks({on:(k,h)=>handlers.set(k,h)},{envelopeFactory:()=>({eventId:`sw_evt_caption${++n}`,installationId:'sw_ins_fixture001',sequence:n,occurredAt:new Date().toISOString(),observedAt:new Date().toISOString(),runtime:{version:'2026.9.8'},source:{kind:'hook',adapterVersion:'0.2.69'}}),emit:e=>{const accepted=life.process(e);if(accepted){events.push(accepted);life.commit(accepted);}}});
 await handlers.get('before_dispatch')({messageId:'request1',sessionKey:'session1'},{});
 const start=life.process({type:'turn.started',correlation:{sessionId:'session1',turnId:'run1'},details:{component:'agent_lifecycle_start'}}); if(start){events.push(start);life.commit(start);}
 params.action='send';
 await handlers.get('after_tool_call')({toolName:'message',params,result:{details:receipt}},{sessionKey:'session1',runId:'run1'});
 await new Promise(r=>setImmediate(r));
 return {events,handlers};
}
test('caption-only source answer exposes safe text and explicit finality',async()=>{
 for(const final of [true,false]){
  const {events}=await observe({caption:'Файл готов — три строки.',final});
  const e=events.find(e=>e.type===(final?'turn.completed':'turn.progress'));
  assert.ok(e);assert.equal(e.messagePreview,'Файл готов — три строки.');
 }
});
test('implicit caption answer has legacy text-final semantics',async()=>{
 const {events}=await observe({caption:'Файл готов — три строки.'});
 assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
 assert.equal(events.find(e=>e.type==='turn.completed').messagePreview,'Файл готов — три строки.');
});
test('unsafe caption completes without preview; failed/foreign delivery is not a source answer',async()=>{
 for(const caption of ['password=not-real-value','token=not-real-value']){
  const {events}=await observe({caption,final:true});const e=events.find(e=>e.type==='turn.completed');assert.ok(e);assert.equal(Object.hasOwn(e,'messagePreview'),false);
 }
 for(const receipt of [{ok:false,sourceReplyRoute:'current-source'},{ok:true},{ok:true,sourceReplyRoute:'current-source',partial:true}]){
  const {events}=await observe({caption:'Файл готов',final:true},receipt);assert.equal(events.filter(e=>e.type==='turn.completed').length,0);
 }
});
test('nonempty message wins without inspecting caption/files/destination',async()=>{
 const params={message:'Ответ готов',final:false};
 for(const key of ['caption','attachments','media','target'])Object.defineProperty(params,key,{enumerable:true,get(){throw Error('unexpected field read');}});
 const {events}=await observe(params);assert.equal(events.find(e=>e.type==='turn.progress').messagePreview,'Ответ готов');
});
test('duplicate exact final source caption does not duplicate completion',async()=>{
 const {events,handlers}=await observe({caption:'Файл готов',final:true});
 await handlers.get('after_tool_call')({toolName:'message',params:{action:'send',caption:'Файл готов',final:true},result:{details:{ok:true,sourceReplyRoute:'current-source'}}},{sessionKey:'session1',runId:'run1'});
 await new Promise(r=>setImmediate(r));assert.equal(events.filter(e=>e.type==='turn.completed').length,1);
});
