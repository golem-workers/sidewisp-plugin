import test from 'node:test';
import assert from 'node:assert/strict';
import {applyHotUpdate,isRetainedWork,isHostIdle} from '../src/update/hot-update.js';
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

const hostIdle = {ts:123,lanes:[{lane:'main',activeCount:0,queuedCount:0,draining:false,blockedBy:null}],dynamic:{activeCount:0,queuedCount:0}};
test('authoritative host idle clears old synthetic telemetry without hiding host work', async()=>{
 let loaded={...old,userTasks:{...old.userTasks,activeRuns:13}},installs=0;
 const snapshots=[{...hostIdle,lanes:[{...hostIdle.lanes[0],activeCount:1}]},hostIdle];const states=[];
 await applyHotUpdate({targetVersion:'0.2.35',status:async()=>loaded,idle:async()=>isHostIdle(snapshots.shift()),
 install:async()=>{installs++;},reload:async()=>{loaded=healthy;},writeState:s=>states.push(s),sleep:async()=>{}});
 assert.equal(installs,1);assert.equal(states[0].reasonCode,'ACTIVE_WORK');assert.equal(states.at(-1).status,'completed');
});
test('queued, dynamic, draining, malformed or missing host evidence never permits mutation',async()=>{
 const invalid=[null,{}, {...hostIdle,ts:0},{...hostIdle,lanes:[]},{...hostIdle,dynamic:{activeCount:1,queuedCount:0}},
 {...hostIdle,lanes:[{...hostIdle.lanes[0],queuedCount:1}]},{...hostIdle,lanes:[{...hostIdle.lanes[0],activeCount:-1}]},
 {...hostIdle,lanes:[{...hostIdle.lanes[0],activeCount:undefined}]},{...hostIdle,lanes:[{...hostIdle.lanes[0],draining:true}]},
 {...hostIdle,lanes:[{...hostIdle.lanes[0],blockedBy:'awaiting-work'}]}];
 for(const snapshot of invalid){let mutations=0;const states=[];
 await applyHotUpdate({targetVersion:'0.2.35',status:async()=>old,idle:async()=>isHostIdle(snapshot),install:async()=>mutations++,reload:async()=>mutations++,writeState:s=>states.push(s),sleep:async()=>{},maxAttempts:2});
 assert.equal(mutations,0);assert.equal(states.at(-1).status,'deferred');}
});
test('host RPC refusal stops rather than falling back to idle collector telemetry',async()=>{
 let mutations=0;
 await assert.rejects(applyHotUpdate({targetVersion:'0.2.35',status:async()=>old,idle:async()=>{throw Error('host diagnostics refused');},install:async()=>mutations++,reload:async()=>mutations++,writeState:()=>{}}),/refused/);
 assert.equal(mutations,0);
});
test('a retained host generation still defers when live host lanes are empty',async()=>{
 let installs=0,reloads=0,loaded=old;
 await applyHotUpdate({targetVersion:'0.2.35',status:async()=>loaded,idle:async()=>isHostIdle(hostIdle),install:async()=>{installs++;throw busy();},reload:async()=>{if(++reloads===1)throw busy();loaded=healthy;},writeState:()=>{},sleep:async()=>{}});
 assert.equal(installs,1);assert.equal(reloads,2);
});

test('real OpenClaw snapshot with no dynamic lanes reports explicit null and is idle',()=>{
 assert.equal(isHostIdle({...hostIdle,dynamic:null}),true);
 assert.equal(isHostIdle({...hostIdle,dynamic:undefined}),false);
});
