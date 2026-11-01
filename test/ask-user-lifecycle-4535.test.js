import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawQuestionObserver } from '../src/adapters/openclaw/questions.js';
import { setup, qid } from './helpers/ask-user-lifecycle-4535.js';
const session='agent:main:telegram:group:fixture', run='87f6a5e5-1519-4fb6-ac6f-7578cfc0eb2d', toolCall='exec-c7af3031-6f2a-4d73-b41f-9d8f2bdd5257';
for(const order of ['end-first','final-first'])test('actual 4521 scenario '+order+' keeps one completion and exact safe final',async()=>{
 const x=setup();try{const resolve=await x.question();assert.equal(qid(),'ask_de83806e2c4daf69030777d230ef5524');
 x.boundary('4525');resolve({status:'answered',get answers(){throw Error('private answer read');}});await Promise.resolve();x.registry.clear();x.pendingRegistry.clear();
 await x.result();assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait').length,1);
 await x.native('assistant',{text:'actual continued execution'});
 if(order==='end-first'){await x.end();assert.equal(x.events.filter(e=>e.type==='turn.completed').length,0);await x.final();}
 else{await x.final();await x.final('duplicate final must not complete early');assert.equal(x.events.filter(e=>e.type==='turn.completed').length,0);await x.end();}
 const waits=x.events.filter(e=>e.details?.component==='ask_user_wait');assert.deepEqual(waits.map(e=>e.type),['tool.started','tool.completed']);assert.equal(waits[0].messagePreview,'Какой цвет выбрать?');assert.ok(waits.every(e=>e.correlation.turnId==='4521'));
 const completed=x.events.filter(e=>e.type==='turn.completed');assert.equal(completed.length,1);assert.equal(completed[0].correlation.turnId,'4521');assert.equal(completed[0].messagePreview,'Получен ответ «no» — цвет не выбран.');
 await x.end();await x.final('late duplicate');await x.native('tool',{phase:'start',name:'ask_user',toolCallId:toolCall});x.time.advance(60000);assert.equal(x.events.filter(e=>e.type==='turn.completed').length,1);assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait').length,2);
 assert.deepEqual(x.life.activeWork().map(w=>w.messageId),['4525']);
 }finally{x.dispose();}
});
for(const mode of ['only-answer','only-disappearance','only-text','wrong-question','wrong-session','only-lifecycle','rejected-promise','pending-status','stale-sequence'])test('no false resumed: '+mode,async()=>{
 const x=setup();try{
 const resolve=await x.question();
 if(mode==='wrong-question'||mode==='wrong-session'){
   // Replace the observer to prove invalid native ownership cannot be attached.
   x.observer.dispose();
   const bad=x.pendingRegistry.get(session);if(mode==='wrong-question')bad.questionId='ask_other';else bad.sessionKey='other';
   // A new independent call tests the mismatched read-only contract below.
   const registry=x.registry,pendingRegistry=x.pendingRegistry,rows=[];const o=createOpenClawQuestionObserver({now:()=>0,pollMs:100000,readRegistry:()=>registry,readPendingRegistry:()=>pendingRegistry,emit:e=>rows.push(e)});
   try{o.observe({stream:'tool',runId:run,seq:1,data:{phase:'start',name:'ask_user',toolCallId:toolCall}});o.scan();resolve({status:'answered'});await Promise.resolve();o.observe({stream:'tool',runId:run,seq:2,data:{phase:'result',name:'ask_user',toolCallId:toolCall,result:{contentItems:[],success:true}}});o.observe({stream:'assistant',runId:run,seq:3,data:{}});await o.drain();assert.equal(rows.filter(e=>e.kind==='tool_end').length,0);}finally{o.dispose();}return;
 }
 if(mode==='only-answer'){resolve({status:'answered'});await Promise.resolve();}
 else if(mode==='only-disappearance')x.registry.clear();
 else if(mode==='pending-status'){resolve({status:'pending'});await Promise.resolve();await x.result();await x.native('assistant',{});}
 else if(mode==='only-lifecycle'){resolve({status:'answered'});await Promise.resolve();await x.result();await x.end();}
 else if(mode==='stale-sequence'){resolve({status:'answered'});await Promise.resolve();await x.result();x.observer.observe({stream:'assistant',runId:run,seq:1,data:{}});await x.observer.drain();}
 else if(mode==='only-text'){await x.result();await x.native('assistant',{});}
 else if(mode==='rejected-promise'){
   resolve.reject(Error('native RPC failure'));await Promise.resolve();await x.result();await x.native('assistant',{});
 }
 assert.equal(x.events.filter(e=>e.type==='tool.completed'&&e.details?.component==='ask_user_wait').length,0);
 }finally{x.dispose();}
});
for(const [name,data,type]of [['cancel',{aborted:true,stopReason:'aborted'},'turn.cancelled'],['timeout',{timedOut:true,stopReason:'timeout'},'turn.timeout'],['error',{success:false,stopReason:'error'},'turn.failed']])for(const order of ['end-first','final-first'])test(name+' '+order+' never becomes success',async()=>{
 const x=setup();try{const resolve=await x.question();x.boundary('4525');resolve({status:'answered'});await Promise.resolve();await x.result();
 if(order==='final-first')await x.final('not a success');await x.end(data);await x.final('late text must not replace outcome');await x.end(data);x.time.advance(60000);
 assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed').length,0);
 const terminals=x.events.filter(e=>['turn.completed','turn.failed','turn.timeout','turn.cancelled'].includes(e.type));assert.deepEqual(terminals.map(e=>e.type),[type]);assert.equal(terminals[0].correlation.turnId,'4521');
 }finally{x.dispose();}
});
test('missing final has bounded deadline, repetitions/admission cannot extend it',async()=>{
 const x=setup();try{await x.question();x.boundary('4525');await x.end();x.time.advance(14999);await x.end();x.boundary('4527');assert.equal(x.events.filter(e=>e.type==='turn.completed').length,0);x.time.advance(1);const ends=x.events.filter(e=>e.type==='turn.completed');assert.equal(ends.length,1);assert.equal(Object.hasOwn(ends[0],'messagePreview'),false);await x.final('too late');assert.equal(x.events.filter(e=>e.type==='turn.completed').length,1);}finally{x.dispose();}
});
test('final without lifecycle has bounded deadline and keeps its exact safe preview',async()=>{const x=setup();try{await x.question();x.boundary('4525');await x.final();x.time.advance(14999);await x.final('late duplicate');assert.equal(x.events.filter(e=>e.type==='turn.completed').length,0);x.time.advance(1);assert.equal(x.events.filter(e=>e.type==='turn.completed').length,1);}finally{x.dispose();}});
test('foreign run or contradictory inbound identity cannot donate preview',async()=>{const x=setup();try{await x.question();x.boundary('4525');await x.end();await x.final('foreign final','other');assert.equal(x.life.process({type:'turn.completed',correlation:{sessionId:session,turnId:run,messageId:'4525'},messagePreview:'foreign',details:{component:'final_reply'}}),null);await x.final();assert.equal(x.events.filter(e=>e.type==='turn.completed')[0].messagePreview,'Получен ответ «no» — цвет не выбран.');}finally{x.dispose();}});
for(const text of ['password=do-not-export','safe '.repeat(34)+' token=do-not-export','x'.repeat(16385),'\u0000unsafe'])test('unsafe published question omitted, not null: '+text.slice(0,25),async()=>{const x=setup();try{await x.question(text);const wait=x.events.find(e=>e.details?.component==='ask_user_wait');assert.equal(Object.hasOwn(wait,'messagePreview'),false);}finally{x.dispose();}});
test('published question preview retains existing single-line/160-unit limits',async()=>{const x=setup();try{await x.question('Какой\n\u200bцвет выбрать? '+'а'.repeat(200));const p=x.events.find(e=>e.details?.component==='ask_user_wait').messagePreview;assert.equal(p.length,160);assert.ok(p.startsWith('Какой цвет выбрать?'));assert.equal(p.includes('\n'),false);}finally{x.dispose();}});
test('parallel exact questions: one answer cannot release another run or question',async()=>{const x=setup();try{const resolve=await x.question();const otherResolve=await x.question('Второй вопрос?','other-run','other-tool','other-session');resolve({status:'answered'});await Promise.resolve();await x.result();await x.native('assistant',{},'other-run');assert.equal(x.events.filter(e=>e.type==='tool.completed'&&e.details?.component==='ask_user_wait').length,0);await x.native('assistant',{});assert.equal(x.events.filter(e=>e.type==='tool.completed'&&e.details?.component==='ask_user_wait').length,1);otherResolve({status:'answered'});await Promise.resolve();await x.native('tool',{phase:'result',name:'ask_user',toolCallId:'other-tool',result:{contentItems:[],success:true}},'other-run');await x.native('assistant',{},'other-run');assert.equal(x.events.filter(e=>e.type==='tool.completed'&&e.details?.component==='ask_user_wait').length,2);}finally{x.dispose();}});
test('parallel questions in the same run keep distinct resolution evidence',async()=>{const x=setup();try{const a=await x.question(),b=await x.question('Другой вопрос?',run,'second');a({status:'answered'});await Promise.resolve();await x.result();await x.native('assistant',{});assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed').length,1);await x.native('tool',{phase:'result',name:'ask_user',toolCallId:'second',result:{contentItems:[],success:true}});await x.native('assistant',{});assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed').length,1);b({status:'answered'});await Promise.resolve();await x.observer.drain();const rows=x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed');assert.equal(rows.length,2);assert.notEqual(rows[0].correlation.toolCallId,rows[1].correlation.toolCallId);}finally{x.dispose();}});
test('delayed native answer observation still requires receipt and actual continuation',async()=>{const x=setup();try{const resolve=await x.question();await x.result();await x.native('assistant',{});assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed').length,0);resolve({status:'answered'});await Promise.resolve();await x.observer.drain();assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed').length,1);}finally{x.dispose();}});
test('late RPC resolution after cancellation cannot manufacture resumed',async()=>{const x=setup();try{const resolve=await x.question();await x.result();await x.end({aborted:true,stopReason:'aborted'});resolve({status:'answered'});await Promise.resolve();await x.native('assistant',{});assert.equal(x.events.filter(e=>e.details?.component==='ask_user_wait'&&e.type==='tool.completed').length,0);}finally{x.dispose();}});
test('intermediate lifecycle after captured final cannot discard its preview',async()=>{const x=setup();try{await x.question();x.boundary('4525');await x.final();await x.end({executionSettled:false,stopReason:'tool_calls'});assert.equal(x.events.filter(e=>e.type==='turn.completed').length,0);await x.end();assert.equal(x.events.filter(e=>e.type==='turn.completed')[0].messagePreview,'Получен ответ «no» — цвет не выбран.');}finally{x.dispose();}});
test('unsafe final stays omitted in the single completed event',async()=>{const x=setup();try{await x.question();x.boundary('4525');await x.end();await x.final('password=unsafe-value');const ends=x.events.filter(e=>e.type==='turn.completed');assert.equal(ends.length,1);assert.equal(Object.hasOwn(ends[0],'messagePreview'),false);}finally{x.dispose();}});
test('broken optional question text cannot suppress published waiting',async()=>{const x=setup();try{await x.native('tool',{phase:'start',name:'ask_user',toolCallId:toolCall});x.registry.set(qid(),{questionId:qid(),sessionKey:session,phase:{kind:'answerable'},expiresAtMs:100000,get questions(){throw Error('unavailable optional preview');}});x.observer.scan();await x.observer.drain();const wait=x.events.find(e=>e.details?.component==='ask_user_wait');assert.equal(wait.type,'tool.started');assert.equal(Object.hasOwn(wait,'messagePreview'),false);}finally{x.dispose();}});
