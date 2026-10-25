import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPendingReleaseStore} from '../src/update/pending-release.js';
import {createTransportDeadline} from '../src/transport/deadline.js';
import {convergeCurrentRelease} from '../src/update/current-release.js';
import {shouldApply} from '../src/update/manager.js';
import {consumeUpdateEvents,maintainUpdateEvents} from '../src/update/event-client.js';
import {createUploader} from '../src/delivery/uploader.js';
const credential={status:'active',installationId:'sw_ins_sleepfixture1',secret:'never-store-this-secret'};
const endpoint='https://sidewisp.test';
const directive={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.88',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.88',sha256:'a'.repeat(64),revision:'sleep-88',mandatory:true,restartDelaySeconds:30};
function fixture(t) {
 const stateDir=mkdtempSync(path.join(os.tmpdir(),'sw-sleep-'));
 mkdirSync(path.join(stateDir,'sidewisp'));
 t.after(()=>rmSync(stateDir,{recursive:true,force:true}));
 return {stateDir,endpoint};
}
test('accepted release survives manager replacement and disconnect without touching settings, binding or spool',async t=>{
 const options=fixture(t),files={
  'settings.json':'{"customPort":18181,"ownerSetting":"keep"}',
  'sidewisp/installation.json':JSON.stringify(credential),
  'sidewisp/spool.sqlite':Buffer.from([0,1,2,3,255]),
 };
 for(const [file,value] of Object.entries(files))writeFileSync(path.join(options.stateDir,file),value);
 const before=Object.keys(files).map(file=>readFileSync(path.join(options.stateDir,file)));
 createPendingReleaseStore(options).accept(directive,credential);
 const durableFile=path.join(options.stateDir,'sidewisp/pending-release.json');
 assert.equal(statSync(durableFile).mode&0o777,0o600);
 assert.ok(!readFileSync(durableFile,'utf8').includes(credential.secret));
 const resumed=createPendingReleaseStore(options).read(credential);
 assert.deepEqual(resumed,directive);
 // The update worker remains busy during normal message handling; a bounded
 // wait expires safely, and a new worker later resumes the same desired state.
 let active=true,installed=0,reloads=0;
 let current={version:'0.2.87',enabled:true,running:true,connectionReadiness:{ready:true}};
 const journal={installCount:0},states=[];
 const operations={targetVersion:resumed.targetVersion,journal,status:async()=>current,idle:async()=>!active,
  verify:async()=>{},install:async()=>{installed++;current={...current,version:directive.targetVersion};},
  reload:async()=>reloads++,activate:async()=>assert.fail('no runtime restart'),write:s=>states.push(s),sleep:async()=>{},maxAttempts:2};
 assert.equal(await convergeCurrentRelease(operations),'deferred');
 assert.equal(installed,0);assert.equal(reloads,0);
 active=false;
 assert.equal(await convergeCurrentRelease(operations),'completed');
 assert.equal(installed,1);assert.equal(reloads,0);
 assert.equal(shouldApply({directive:resumed,currentVersion:directive.targetVersion,attempt:{targetVersion:directive.targetVersion,revision:directive.revision,status:'completed'}}),false);
 Object.keys(files).forEach((file,index)=>assert.deepEqual(readFileSync(path.join(options.stateDir,file)),before[index]));
 assert.ok(states.some(s=>s.reasonCode==='ACTIVE_WORK'));
});
test('policy withdrawal, credential rotation and another profile cannot replay an old accepted release',t=>{
 const options=fixture(t),store=createPendingReleaseStore(options);store.accept(directive,credential);
 for(const changed of [{...credential,status:'revoked'},{...credential,installationId:'sw_ins_other'},{...credential,secret:'rotated'}])assert.equal(store.read(changed),null);
 assert.equal(createPendingReleaseStore({...options,endpoint:'https://other.test'}).read(credential),null);
 const another=fixture(t);writeFileSync(path.join(another.stateDir,'sidewisp/pending-release.json'),readFileSync(path.join(options.stateDir,'sidewisp/pending-release.json')));
 assert.equal(createPendingReleaseStore(another).read(credential),null);
 assert.throws(()=>store.accept({...directive,sha256:'invalid'},credential),/INVALID_CONTROL_RESPONSE/);
 assert.deepEqual(store.read(credential),directive);
 store.accept(null,credential);assert.equal(createPendingReleaseStore(options).read(credential),null);
 store.accept(null,credential);
 writeFileSync(path.join(options.stateDir,'sidewisp/pending-release.json'),'broken');
 assert.throws(()=>store.read(credential),/INVALID_PENDING_RELEASE/);
});
test('wall-clock deadline expires on first tick after suspended active-time timers and cleans up',()=>{
 let now=1000,check,cleared=0;
 const deadline=createTransportDeadline({timeoutMs:90000,now:()=>now,setIntervalImpl:fn=>{check=fn;return 42;},clearIntervalImpl:id=>{assert.equal(id,42);cleared++;}});
 now+=10000;check();assert.equal(deadline.signal.aborted,false);
 deadline.reset(90000);now+=3600000;check();assert.equal(deadline.signal.aborted,true);assert.equal(deadline.signal.reason.name,'TimeoutError');
 deadline.close();assert.equal(cleared,1);
 const controller=new AbortController();controller.abort();const cancelled=createTransportDeadline({timeoutMs:10,signal:controller.signal});assert.equal(cancelled.signal.aborted,true);cancelled.close();
});
test('pre-sleep event stream is discarded and reconnect receives latest snapshot with fresh signed nonce',async()=>{
 let now=1000,check,connections=0;const nonces=[],received=[];
 const stopped=new AbortController();
 await maintainUpdateEvents({signal:stopped.signal,sleep:async()=>{},connect:async connected=>{
  connections++;
  await consumeUpdateEvents({endpoint,credential,report:{managerVersion:'0.2.88'},signal:stopped.signal,
   deadlineFactory:options=>createTransportDeadline({...options,now:()=>now,setIntervalImpl:fn=>{check=fn;return 1;},clearIntervalImpl:()=>{}}),
   fetchImpl:async(_url,init)=>{
    nonces.push(init.headers['x-sidewisp-nonce']);
    if(connections===1){now+=3600000;check();throw init.signal.reason;}
    return new Response(`data: ${JSON.stringify({schema:'sidewisp.update-events.v1',installationId:credential.installationId,update:directive})}\n\n`,{headers:{'content-type':'text/event-stream'}});
   },onDirective:d=>{connected();received.push(d);stopped.abort();}});
 }});
 assert.equal(connections,2);assert.equal(new Set(nonces).size,2);assert.deepEqual(received,[directive]);
});
test('shared uploader: interrupted telemetry body remains queued and reconnect acknowledges it once',async()=>{
 let pending=[{eventId:'sleep-event'}],calls=0,acknowledged=0;
 const spool={pending:limit=>pending.slice(0,limit).map(event=>({eventId:event.eventId,event})),acknowledge:ids=>{acknowledged+=ids.length;pending=pending.filter(event=>!ids.includes(event.eventId));}};
 const uploader=createUploader({spool,endpoint,credentialProvider:{current:async()=>credential},sleep:async()=>{},fetchImpl:async()=>{
  calls++;return {ok:true,status:200,json:async()=>{if(calls===1)throw new DOMException('interrupted body','TimeoutError');return {acknowledgedEventIds:['sleep-event']};}};
 }});
 assert.equal((await uploader.sendOnce()).status,'retry');assert.equal(pending.length,1);
 assert.equal((await uploader.drain()).status,'idle');assert.equal(pending.length,0);assert.equal(acknowledged,1);
});
