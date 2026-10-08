import test from 'node:test';import assert from 'node:assert/strict';
import {consumeUpdateEvents,maintainUpdateEvents} from '../src/update/event-client.js';
import {signBatch} from '../src/delivery/uploader.js';
const credential={installationId:'sw_ins_eventstest123',secret:'test-secret'};
const directive={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.50',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.50',sha256:'a'.repeat(64),revision:'event-50',mandatory:true,restartDelaySeconds:30};
const options={endpoint:'https://staging-api.sidewisp.com',credential,report:{managerVersion:'0.2.50',currentVersion:'0.2.49',status:'idle'}};
function reply(text){return new Response(new ReadableStream({start(c){const bytes=new TextEncoder().encode(text);for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});}
function frame(update,installationId=credential.installationId){return `data: ${JSON.stringify({schema:'sidewisp.update-events.v1',installationId,update})}\n\n`;}
test('client signs POST and consumes split frames, keepalives and withdrawal without discovery requests',async()=>{
 const calls=[],received=[];const controller=new AbortController();
 await consumeUpdateEvents({...options,signal:controller.signal,onDirective:async d=>{received.push(d);if(received.length===2)controller.abort();},fetchImpl:async(url,init)=>{
  calls.push(url.pathname);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const expected=signBatch({secret:credential.secret,timestamp:init.headers['x-sidewisp-timestamp'],nonce:init.headers['x-sidewisp-nonce'],body:init.body});assert.equal(init.headers.authorization,`Sidewisp ${credential.installationId}:${expected}`);
  return reply(': keepalive\n\n'+frame(directive)+frame(null));
 }});assert.deepEqual(calls,['/v1/installations/update-events']);assert.deepEqual(received,[directive,null]);
});
test('invalid identity/directive, redirect, content type and oversized frames fail closed',async()=>{
 for(const text of [frame(directive,'sw_ins_other12345'),frame({...directive,sha256:'bad'}),'data: '+'a'.repeat(70000)+'\n\n'])await assert.rejects(consumeUpdateEvents({...options,onDirective:()=>assert.fail('must not apply'),fetchImpl:async()=>reply(text)}));
 await assert.rejects(consumeUpdateEvents({...options,onDirective:()=>{},fetchImpl:async()=>new Response('',{status:401})}),/CREDENTIAL_REJECTED/);
 await assert.rejects(consumeUpdateEvents({...options,onDirective:()=>{},fetchImpl:async()=>new Response('{}')}),/INVALID_EVENT_STREAM/);
 await assert.rejects(consumeUpdateEvents({...options,onDirective:()=>{},fetchImpl:async()=>reply(frame(null))}),/CONTROL_DISCONNECTED/);
});
test('only disconnect triggers bounded backoff; successful reconnection resets it and cancellation ends retry',async()=>{
 const controller=new AbortController(),waits=[];let connects=0;
 await maintainUpdateEvents({signal:controller.signal,connect:async connected=>{connects++;if(connects===3)connected();if(connects===4){controller.abort();return;}throw Error('CONTROL_UNAVAILABLE');},sleep:async ms=>waits.push(ms)});
 assert.deepEqual(waits,[1000,2000,1000]);assert.equal(connects,4);
});
test('silent broken transport is aborted; liveness deadlines do not request a release',async()=>{
 let calls=0;await assert.rejects(consumeUpdateEvents({...options,connectTimeoutMs:10,fetchImpl:async(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('TIMEOUT')),{once:true}));},onDirective:()=>{}}),/TIMEOUT/);assert.equal(calls,1);
});
