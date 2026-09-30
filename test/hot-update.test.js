import test from 'node:test';
import assert from 'node:assert/strict';
import {applyHotUpdate,isRetainedWork} from '../src/update/hot-update.js';
const old = {version:'0.2.34',userTasks:{activeRuns:0,pendingTerminals:0,awaitingFinals:0,pendingInboundObservations:0}};
const healthy = {version:'0.2.35',enabled:true,running:true,connectionReadiness:{ready:true}};
const busy = () => new Error('Plugin sidewisp still has active retained work; retry after the work finishes.');
test('persisted install waits for host work; reloads without reinstall or Gateway restart',async()=>{
 let installs=0,reloads=0,loaded=old; const states=[];
 await applyHotUpdate({targetVersion:'0.2.35',status:async()=>loaded,install:async()=>{installs++;throw busy();},
 reload:async()=>{if(++reloads===1)throw busy();loaded=healthy;},writeState:s=>states.push(s),sleep:async()=>{}});
 assert.equal(installs,1);assert.equal(reloads,2);assert.equal(states.at(-1).status,'completed');
 assert.equal(states.filter(s=>s.reasonCode==='HOST_RETAINED_WORK').length,2);
});
test('a real policy denial is not retried and does not trigger reload',async()=>{
 let reloads=0,installs=0;
 await assert.rejects(applyHotUpdate({targetVersion:'0.2.35',status:async()=>old,install:async()=>{installs++;throw new Error('capability approval denied');},
 reload:async()=>reloads++,writeState:()=>{},sleep:async()=>{}}),/approval denied/);
 assert.equal(installs,1);assert.equal(reloads,0);assert.equal(isRetainedWork(new Error('busy policy denied')),false);
});
test('active tasks and missing idle evidence leave the running plugin untouched',async()=>{
 for(const userTasks of [undefined,{...old.userTasks,activeRuns:1},{...old.userTasks,pendingTerminals:1}]){
 let mutations=0;const states=[];
 await applyHotUpdate({targetVersion:'0.2.35',status:async()=>({...old,userTasks}),install:async()=>mutations++,reload:async()=>mutations++,
 writeState:s=>states.push(s),sleep:async()=>{},maxAttempts:3});
 assert.equal(mutations,0);assert.equal(states.at(-1).status,'deferred');}
});
test('version alone is not success: target collector must be ready',async()=>{
 await assert.rejects(applyHotUpdate({targetVersion:'0.2.35',status:async()=>({...healthy,running:false}),writeState:()=>{},sleep:async()=>{}}),/UNHEALTHY/);
});
