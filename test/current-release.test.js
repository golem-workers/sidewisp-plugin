import test from 'node:test';
import assert from 'node:assert/strict';
import {convergeCurrentRelease} from '../src/update/current-release.js';
import {shouldApply} from '../src/update/manager.js';

const targetVersion='0.2.61';
const pending={version:targetVersion,enabled:true,running:true,connectionReadiness:{ready:false,activationRequired:true}};
const ready={...pending,connectionReadiness:{ready:true,activationRequired:false}};
test('installed but unready target requires a fresh revision after a failed activation',()=>{
 const directive={schema:'sidewisp.plugin-update.v1',targetVersion,targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.61',sha256:'a'.repeat(64),revision:'activation-failed',mandatory:true,restartDelaySeconds:30};
 const attempt={mode:'single_current',targetVersion,revision:directive.revision,status:'failed'};
 const state={directive,currentVersion:targetVersion,currentReady:false,attempt};
 assert.equal(shouldApply(state),false);
 assert.equal(shouldApply({...state,directive:{...directive,revision:'activation-recovery'}}),true);
 assert.equal(shouldApply({...state,directive:{...directive,revision:'activation-recovery'},active:true}),false);
});
function setup(overrides={}) {
 const states=[],journal={mutated:false,staged:false,activated:false,installCount:0};
 return {states,journal,options:{targetVersion,journal,status:async()=>pending,idle:async()=>true,
  install:async()=>assert.fail('already installed target must not be reinstalled'),
  reload:async()=>assert.fail('activation must not reload the package'),
  activate:async()=>{},verify:async()=>{},sleep:async()=>{},maxAttempts:4,
  write:state=>{Object.assign(journal,state);states.push({...journal});},...overrides}};
}
test('activation-only recovery persists its mutation intent before losing the helper',async()=>{
 const f=setup({activate:async()=>{throw Error('simulated helper interruption');}});
 await assert.rejects(convergeCurrentRelease(f.options),/simulated helper interruption/);
 const checkpoint=f.states.find(s=>s.phase==='activation_intent');
 assert.equal(checkpoint.mutated,true);
 assert.equal(checkpoint.staged,true);
 assert.equal(checkpoint.installCount,0);
 // Next process sees the persisted checkpoint while the Gateway is unreachable.
 let reads=0,recoveries=0;
 const result=await convergeCurrentRelease({...f.options,status:async()=>{if(reads++===0)throw Error('gateway restarting');return ready;},
  recoverStopped:async()=>{recoveries++;return false;},activate:async()=>assert.fail('no second restart')});
 assert.equal(result,'completed');assert.equal(recoveries,1);assert.equal(f.journal.installCount,0);
});
test('busy activation-only target defers then completes without reinstalling after idle',async()=>{
 let idle=false,activated=false,count=0;
 const f=setup({idle:async()=>idle,status:async()=>activated?ready:pending,activate:async()=>{count++;activated=true;}});
 assert.equal(await convergeCurrentRelease(f.options),'deferred');
 assert.equal(f.journal.mutated,false);assert.equal(count,0);
 idle=true;
 assert.equal(await convergeCurrentRelease(f.options),'completed');assert.equal(count,1);assert.equal(f.journal.installCount,0);
});
test('activation refusal is propagated without another activation attempt or claimed success',async()=>{
 let count=0;const f=setup({activate:async()=>{count++;throw Error('TASK_SCOPE_GUARD_REJECTED');}});
 await assert.rejects(convergeCurrentRelease(f.options),/TASK_SCOPE_GUARD_REJECTED/);
 assert.equal(count,1);assert.ok(!f.states.some(s=>s.status==='completed'));assert.equal(f.journal.installCount,0);
});
