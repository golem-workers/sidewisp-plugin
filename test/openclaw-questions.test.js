import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createOpenClawQuestionObserver} from '../src/adapters/openclaw/questions.js';
let sequence=0;
const event=(stream,data,runId='r',sessionKey='agent:main:telegram:group:s')=>({stream,data,runId,sessionKey,seq:++sequence});
const tool=(phase,result,toolCallId='t')=>event('tool',{name:'ask_user',phase,toolCallId,result});
const questionId=t=>'ask_'+createHash('sha256').update('r\0'+t).digest('hex').slice(0,32);
function setup(){const registry=new Map(),events=[];const o=createOpenClawQuestionObserver({emit:i=>events.push(i),readRegistry:()=>registry,now:()=>100,pollMs:10000});const state=(phase,t='t',expiresAtMs=1000)=>registry.set(questionId(t),{sessionKey:'agent:main:telegram:group:s',phase:{kind:phase},expiresAtMs});return{registry,events,o,state};}
test('reserved, registering, prompting, failed delivery and expired are not waits',async()=>{const{s:ignored,...x}=setup();try{x.o.observe(tool('start'));for(const p of ['reserved','registering','prompting','prompt-failed','resolving']){x.state(p);x.o.scan();}x.state('answerable','t',99);x.o.scan();await x.o.drain();assert.equal(x.events.length,0);}finally{x.o.dispose();}});
test('real answerable wait and native answered receipt need actual same-run continuation',async()=>{const x=setup();try{x.o.observe(tool('start'));x.state('answerable');x.o.scan();x.o.scan();await x.o.drain();assert.equal(x.events.length,1);x.o.observe(tool('result',{details:{status:'answered'}}));await x.o.drain();assert.equal(x.events.length,1);x.o.observe(event('assistant',{text:'other'},'other'));await x.o.drain();assert.equal(x.events.length,1);x.o.observe(event('assistant',{text:'continuation'}));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start','tool_end']);assert.equal(x.events[0].correlation.toolCallId,questionId('t'));x.o.observe(event('assistant',{text:'duplicate'}));await x.o.drain();assert.equal(x.events.length,2);}finally{x.o.dispose();}});
for(const status of ['answered','no_answer'])test(status+' + success end resumes once before terminal processing',async()=>{const x=setup();try{x.o.observe(tool('start'));x.state('answerable');x.o.scan();x.o.observe(tool('result',{details:{status}}));x.o.observe(event('assistant',{text:'real continuation'}));x.o.observe(event('lifecycle',{phase:'end',stopReason:'stop'}));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start','tool_end']);}finally{x.o.dispose();}});
for(const ending of [{phase:'error',aborted:true},{phase:'end',aborted:true},{phase:'error',stopReason:'timeout'},{phase:'end',stopReason:'restart'}])test('no false resumed or final from '+JSON.stringify(ending),async()=>{const x=setup();try{x.o.observe(tool('start'));x.state('answerable');x.o.scan();x.o.observe(tool('result',{details:{status:'no_answer'}}));x.o.observe(event('lifecycle',ending));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start']);}finally{x.o.dispose();}});
test('multiple questions in same work are separate balanced waits',async()=>{const x=setup();try{for(const t of ['t','t2']){x.o.observe(tool('start',null,t));x.state('answerable',t);x.o.scan();x.o.observe(tool('result',{details:{status:'answered'}},t));x.o.observe(event('assistant',{text:'continue'}));await x.o.drain();}assert.deepEqual(x.events.map(e=>e.kind),['tool_start','tool_end','tool_start','tool_end']);assert.notEqual(x.events[0].correlation.toolCallId,x.events[2].correlation.toolCallId);}finally{x.o.dispose();}});
test('tool error alone, question text and unknown receipt cannot manufacture resolution',async()=>{const x=setup();try{x.o.observe(tool('start'));x.state('answerable');x.o.scan();x.o.observe(tool('result',{content:[{type:'text',text:'answered'}]}));x.o.observe(event('assistant',{text:'continue'}));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start']);}finally{x.o.dispose();}});
test('missing contract and mismatched session fail closed; dispose retires wait',async()=>{const x=setup();x.o.observe(tool('start'));x.state('answerable');x.registry.get(questionId('t')).sessionKey='elsewhere';x.o.scan();await x.o.drain();assert.equal(x.events.length,0);x.o.dispose();x.state('answerable');x.o.scan();await x.o.drain();assert.equal(x.events.length,0);});

test('late duplicate tool start and stale assistant event cannot resume a resolved wait',async()=>{const x=setup();try{const start=tool('start');x.o.observe(start);x.state('answerable');x.o.scan();const result=tool('result',{details:{status:'answered'}});x.o.observe(result);x.o.observe(start);x.o.observe({...event('assistant',{text:'stale'}),seq:result.seq-1});await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start']);x.o.observe(event('assistant',{text:'real continuation'}));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start','tool_end']);}finally{x.o.dispose();}});

// Recorded live identifiers/structured tool shape from turn 4468. seq is
// normalized locally; no plaintext answer/sender or inferred session is stored.
const live = JSON.parse(await readFile(new URL('./fixtures/ask-user-live-no-session.json', import.meta.url), 'utf8'));
const liveQuestion='ask_8b071f5edf094e94231577b02b49969f';
const withoutSession=e=>{const {sessionKey,...rest}=e;return rest;};
test('live tool shape without sessionKey binds exact registry entry, not delivery metadata', async()=>{
 const registry=new Map(),events=[];const o=createOpenClawQuestionObserver({emit:e=>events.push(e),readRegistry:()=>registry,now:()=>100,pollMs:10000});
 try{
  const start=structuredClone(live);assert.equal(start.sessionKey,undefined);o.observe(start);
  registry.set(liveQuestion,{questionId:liveQuestion,sessionKey:'agent:main:telegram:group:live',phase:{kind:'answerable'},expiresAtMs:1000});
  o.scan();o.scan();await o.drain();assert.equal(events.length,1);assert.equal(events[0].correlation.turnId,live.runId);assert.equal(events[0].correlation.sessionId,'agent:main:telegram:group:live');
  o.observe({...start,seq:2,data:{...start.data,phase:'result',result:{details:{status:'answered'}}}});registry.delete(liveQuestion);await o.drain();assert.equal(events.length,1);
  o.observe({runId:live.runId,stream:'assistant',seq:3,data:{text:'continue'}});await o.drain();assert.deepEqual(events.map(e=>e.kind),['tool_start','tool_end']);
  registry.set(liveQuestion,{sessionKey:'agent:main:telegram:group:live',phase:{kind:'answerable'},expiresAtMs:1000});o.observe({...start,seq:4});o.scan();await o.drain();assert.equal(events.length,2);
 }finally{o.dispose();}
});
test('parallel sessions and concurrent runs in one session remain isolated without keys',async()=>{
 const registry=new Map(),events=[];const o=createOpenClawQuestionObserver({emit:e=>events.push(e),readRegistry:()=>registry,now:()=>100,pollMs:10000});
 const q=r=>'ask_'+createHash('sha256').update(r+'\0shared').digest('hex').slice(0,32);
 const runs=[['a','s1'],['b','s2'],['c','s1']];
 try{for(const[r,s]of runs){o.observe({stream:'tool',runId:r,seq:1,data:{name:'ask_user',phase:'start',toolCallId:'shared'}});registry.set(q(r),{questionId:q(r),sessionKey:s,phase:{kind:'answerable'},expiresAtMs:1000});}o.scan();await o.drain();assert.equal(events.length,3);
 o.observe({stream:'tool',runId:'b',seq:2,data:{name:'ask_user',phase:'result',toolCallId:'shared',result:{details:{status:'answered'}}}});
 o.observe({stream:'assistant',runId:'a',seq:3,data:{text:'not b'}});await o.drain();assert.equal(events.length,3);
 o.observe({stream:'assistant',runId:'b',seq:3,data:{text:'b'}});await o.drain();assert.deepEqual(events.filter(e=>e.kind==='tool_end').map(e=>e.correlation),[{sessionId:'s2',turnId:'b',toolCallId:q('b')}]);
 }finally{o.dispose();}
});
for(const mode of ['explicit-conflict','registry-change','ambiguous-run','wrong-id'])test('fail closed on '+mode,async()=>{
 const x=setup();try{
  if(mode==='explicit-conflict'){x.o.observe(tool('start'));x.state('answerable');x.registry.get(questionId('t')).sessionKey='other';}
  else {x.o.observe(withoutSession(tool('start')));x.state(mode==='registry-change'?'reserved':'answerable');}
  if(mode==='registry-change'){x.o.scan();x.registry.get(questionId('t')).sessionKey='other';}
  if(mode==='wrong-id')x.registry.get(questionId('t')).questionId='wrong';
  if(mode==='ambiguous-run'){x.o.observe(withoutSession(tool('start',null,'t2')));x.state('answerable','t2');x.registry.get(questionId('t2')).sessionKey='other';}
  x.o.scan();await x.o.drain();const before=x.events.length;
  x.o.observe(withoutSession(tool('result',{details:{status:'answered'}})));x.o.observe(withoutSession(event('assistant',{text:'continue'})));await x.o.drain();assert.equal(x.events.length,before);assert.equal(x.events.filter(e=>e.kind==='tool_end').length,0);
 }finally{x.o.dispose();}
});
for(const ending of [{phase:'error',aborted:true},{phase:'end',aborted:true},{phase:'error',stopReason:'timeout'},{phase:'end',stopReason:'restart'}])test('no-key cancellation/error keeps wait without resumed '+JSON.stringify(ending),async()=>{const x=setup();try{x.o.observe(withoutSession(tool('start')));x.state('answerable');x.o.scan();x.o.observe(withoutSession(tool('result',{details:{status:'no_answer'}})));x.o.observe(withoutSession(event('lifecycle',ending)));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start']);}finally{x.o.dispose();}});
test('no-key tool failure and missing registry cannot create continuation',async()=>{const x=setup();try{x.o.observe(withoutSession(tool('start')));x.o.scan();await x.o.drain();assert.equal(x.events.length,0);x.state('answerable');x.o.scan();x.o.observe({...withoutSession(tool('result',{details:{status:'answered'}})),data:{name:'ask_user',phase:'result',toolCallId:'t',isError:true,result:{details:{status:'answered'}}}});x.o.observe(withoutSession(event('assistant',{text:'continue'})));await x.o.drain();assert.deepEqual(x.events.map(e=>e.kind),['tool_start']);}finally{x.o.dispose();}});
test('two conflicting registry identities available in one scan emit no guessed wait',async()=>{
 const x=setup();try{
  x.o.observe(withoutSession(tool('start')));x.o.observe(withoutSession(tool('start',null,'t2')));
  x.state('answerable');x.state('answerable','t2');x.registry.get(questionId('t2')).sessionKey='other';
  x.o.scan();await x.o.drain();assert.deepEqual(x.events,[]);
 }finally{x.o.dispose();}
});
