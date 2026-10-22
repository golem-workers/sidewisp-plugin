import test from 'node:test';import assert from 'node:assert/strict';import {createUploadPump} from '../src/delivery/upload-pump.js';
const tick=()=>new Promise(r=>setImmediate(r));
test('committed lifecycle events wake immediately, serialize uploads and preserve new events during a send',async()=>{let id=0;const jobs=new Map(),sent=[],queue=[];let release,active=0,maxActive=0;const gate=new Promise(r=>release=r);const pump=createUploadPump({setTimer:(fn,ms)=>{jobs.set(++id,{fn,ms});return id;},clearTimer:id=>jobs.delete(id),upload:async()=>{maxActive=Math.max(maxActive,++active);const batch=queue.splice(0);if(!sent.length)await gate;sent.push(...batch);active--;}});queue.push('start-1');pump.request();for(let i=0;i<20;i++)pump.request();assert.equal(jobs.size,1);let [key,job]=jobs.entries().next().value;assert.ok(job.ms<100);jobs.delete(key);job.fn();await tick();queue.push('complete-1','start-2','complete-2','start-3','complete-3');pump.request();assert.equal(jobs.size,0);release();await tick();[key,job]=jobs.entries().next().value;jobs.delete(key);job.fn();await tick();assert.deepEqual(sent,['start-1','complete-1','start-2','complete-2','start-3','complete-3']);assert.equal(maxActive,1);await pump.stop();pump.request();assert.equal(jobs.size,0);});
test('a failed send leaves the pump reusable without an overlapping retry',async()=>{const errors=[];let calls=0,id=0;const jobs=new Map();const pump=createUploadPump({setTimer:fn=>{jobs.set(++id,fn);return id;},clearTimer:id=>jobs.delete(id),upload:async()=>{if(++calls===1)throw Error('offline');},onError:error=>errors.push(error)});for(let i=0;i<2;i++){pump.request();const [key,fn]=jobs.entries().next().value;jobs.delete(key);fn();await tick();}assert.equal(calls,2);assert.equal(errors.length,1);await pump.stop();});


test('one wake drains an acknowledged backlog through the real uploader without waiting for another task',async()=>{
 const {createUploader}=await import('../src/delivery/uploader.js');
 const rows=Array.from({length:350},(_,i)=>({eventId:'health-'+i}));
 rows.push({eventId:'task-start'},{eventId:'task-complete'});
 const delivered=[],jobs=new Map();let id=0,active=0,maxActive=0;
 const spool={pending:limit=>rows.slice(0,limit).map(event=>({eventId:event.eventId,event})),acknowledge:ids=>{for(const id of ids){const at=rows.findIndex(e=>e.eventId===id);if(at>=0)rows.splice(at,1);}},deadLetter(){assert.fail('no data may be discarded');}};
 const uploader=createUploader({spool,endpoint:'https://sidewisp.test',compressThresholdBytes:1000000,credentialProvider:{current:async()=>({installationId:'sw_ins_backlog123',secret:'fixture',status:'active'})},fetchImpl:async(_url,init)=>{
  maxActive=Math.max(maxActive,++active);const ids=JSON.parse(init.body).events.map(e=>e.eventId);delivered.push(...ids);await tick();active--;
  return {ok:true,status:200,json:async()=>({acknowledgedEventIds:ids})};
 }});
 const pump=createUploadPump({upload:()=>uploader.drain({maxAttempts:1}),setTimer:(fn,ms)=>{jobs.set(++id,{fn,ms});return id;},clearTimer:id=>jobs.delete(id)});
 pump.request();let batches=0;
 while(jobs.size && ++batches<10){const [id,{fn,ms}]=jobs.entries().next().value;jobs.delete(id);assert.ok(ms<100);fn();for(let i=0;i<8;i++)await tick();}
 assert.equal(rows.length,0);assert.equal(batches,4);assert.equal(new Set(delivered).size,352);assert.deepEqual(delivered.slice(-2),['task-start','task-complete']);assert.equal(maxActive,1);await pump.stop();
});

test('backpressure without a positive ACK never creates a self-retry loop',async()=>{
 for(const result of [{status:'backpressure',sent:0,remaining:1},{status:'retry',sent:0,remaining:1},{status:'credential-rejected',sent:0,remaining:1}]){
  let id=0,calls=0;const jobs=new Map();const pump=createUploadPump({upload:async()=>{calls++;return result;},setTimer:fn=>{jobs.set(++id,fn);return id;},clearTimer:id=>jobs.delete(id)});
  pump.request();const [key,fn]=jobs.entries().next().value;jobs.delete(key);fn();await tick();assert.equal(calls,1);assert.equal(jobs.size,0);await pump.stop();
 }
});
