import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {createActivationReadiness} from '../src/adapters/openclaw/activation-readiness.js';
import {coldActivateOpenClaw,startStoppedOpenClaw} from '../scripts/cold-activate-openclaw.mjs';
test('affected SDK requires bootstrap-owned service context, not a replayed lifecycle hook; other SDK is untouched',()=>{
 const old=createActivationReadiness('2026.9.8');assert.equal(old.required(),true);old.serviceStarted({});assert.equal(old.required(),true);old.serviceStarted({startupTrace:{measure(){}}});assert.equal(old.required(),false);
 assert.equal(createActivationReadiness('2026.10.1').required(),false);
});
async function fixture(fn){const stateDir=mkdtempSync(path.join(os.tmpdir(),'sw-activation-'));const configPath=path.join(stateDir,'openclaw.json');writeFileSync(configPath,'{}');try{await fn({stateDir,configPath});}finally{rmSync(stateDir,{recursive:true,force:true});}}
const managed=({stateDir,configPath})=>({service:{loaded:true,runtime:{status:'running',pid:123},command:{environment:{OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:configPath}}},config:{daemon:{path:configPath}}});
test('activation uses only exact managed profile and atomic idle fence, without force',()=>fixture(async f=>{
 const calls=[];await coldActivateOpenClaw({...f,run:a=>{calls.push(a);return JSON.stringify(a[1]==='status'?managed(f):a[1]==='suspend'?{status:'ready',suspensionId:'ours'}:{result:'restarted'});}});
 assert.deepEqual(calls.map(a=>a[1]),['status','suspend','restart']);assert.ok(calls.every(a=>!a.includes('--force')&&!a.includes('--skip-deferral')));
}));
test('unmanaged, mismatched or uncertain service never fences or restarts',()=>fixture(async f=>{
 for(const mutate of [s=>s.service.loaded=false,s=>s.service.runtime.status='stopped',s=>s.service.targetRole='diagnostic-only',s=>s.config.mismatch=true,s=>s.service.command.environment.OPENCLAW_STATE_DIR=os.tmpdir(),s=>s.config.daemon.path=os.tmpdir()]){
  const s=managed(f);mutate(s);let calls=0;await assert.rejects(coldActivateOpenClaw({...f,run:()=>{calls++;return JSON.stringify(s);}}),/managed_active_profile_required/);assert.equal(calls,1);
 }
}));
test('host busy fence defers without restart or policy alternative',()=>fixture(async f=>{
 const calls=[];await assert.rejects(coldActivateOpenClaw({...f,run:a=>{calls.push(a[1]);if(a[1]==='status')return JSON.stringify(managed(f));throw Object.assign(Error('exit1'),{stdout:JSON.stringify({status:'busy'})});}}),/host_activation_busy/);assert.deepEqual(calls,['status','suspend']);
}));
test('suspension denial stops with no restart or resume of someone else',()=>fixture(async f=>{
 const calls=[];await assert.rejects(coldActivateOpenClaw({...f,run:a=>{calls.push(a[1]);if(a[1]==='status')return JSON.stringify(managed(f));throw Error('policy_denied');}}),/policy_denied/);assert.deepEqual(calls,['status','suspend']);
}));
test('restart failure releases only the acquired lease and is not retried',()=>fixture(async f=>{
 const calls=[];await assert.rejects(coldActivateOpenClaw({...f,run:a=>{calls.push(a);if(a[1]==='status')return JSON.stringify(managed(f));if(a[1]==='suspend')return JSON.stringify({status:'ready',suspensionId:'ours'});if(a[1]==='restart')throw Error('restart_denied');return '{}';}}),/restart_denied/);assert.deepEqual(calls.map(a=>a[1]),['status','suspend','restart','resume']);assert.equal(calls.at(-1)[2],'ours');
}));

test('missing profile env and missing config paths report safe profile refusal',()=>fixture(async f=>{
 for(const broken of [{...f,configPath:undefined},{...f,stateDir:undefined},{...f,configPath:'/no-such-sidewisp-fixture-config'}]){await assert.rejects(coldActivateOpenClaw({...broken,run:()=>JSON.stringify(managed(f))}),/managed_active_profile_required/);}
}));

test('stopped recovery prepares exact target before starting and never operates on another profile',()=>fixture(async f=>{
 const calls=[];const stopped=managed(f);stopped.service.runtime={status:'stopped',pid:0};
 await startStoppedOpenClaw({...f,prepare:()=>calls.push('prepare'),run:a=>{calls.push(a[1]);return JSON.stringify(stopped);}});assert.deepEqual(calls,['status','prepare','start']);
 const running=managed(f);const other=managed(f);other.config.daemon.path=os.tmpdir();
 for(const snapshot of [running,other]){let prepared=false;let starts=0;try{await startStoppedOpenClaw({...f,prepare:()=>prepared=true,run:a=>{if(a[1]==='start')starts++;return JSON.stringify(snapshot);}});}catch{}assert.equal(prepared,false);assert.equal(starts,0);}
}));


test('restart readiness timeout observes delayed matched new PID without another restart or resume',()=>fixture(async f=>{
 const calls=[];let probes=0;
 await coldActivateOpenClaw({...f,sleep:async()=>{},run:a=>{calls.push(a[1]);if(a[1]==='status'){const s=managed(f);if(++probes===2)s.service.runtime={status:'stopped',pid:0};if(probes>=3)s.service.runtime.pid=456;return JSON.stringify(s);}if(a[1]==='suspend')return JSON.stringify({status:'ready',suspensionId:'ours'});if(a[1]==='restart')throw Object.assign(Error('exit1'),{stdout:'Timed out waiting for gateway health'});throw Error('unexpected');}});
 assert.deepEqual(calls,['status','suspend','restart','status','status']);
}));
test('timeout with unchanged PID never claims activation and releases only its lease',()=>fixture(async f=>{
 const calls=[];await assert.rejects(coldActivateOpenClaw({...f,sleep:async()=>{},restartProbeAttempts:2,run:a=>{calls.push(a);if(a[1]==='status')return JSON.stringify(managed(f));if(a[1]==='suspend')return JSON.stringify({status:'ready',suspensionId:'ours'});if(a[1]==='restart')throw Error('timed out');return '{}';}}),/timed out/);
 assert.equal(calls.filter(a=>a[1]==='restart').length,1);assert.equal(calls.at(-1)[1],'resume');assert.equal(calls.at(-1)[2],'ours');
}));
test('timeout never accepts replacement process in a different profile',()=>fixture(async f=>{
 let probes=0;const calls=[];await assert.rejects(coldActivateOpenClaw({...f,sleep:async()=>{},run:a=>{calls.push(a[1]);if(a[1]==='status'){const s=managed(f);if(++probes>1){s.service.runtime.pid=456;s.service.command.environment.OPENCLAW_STATE_DIR=os.tmpdir();}return JSON.stringify(s);}if(a[1]==='suspend')return JSON.stringify({status:'ready',suspensionId:'ours'});if(a[1]==='restart')throw Error('timed out');return '{}';}}),/timed out/);assert.deepEqual(calls,['status','suspend','restart','status','resume']);
}));
