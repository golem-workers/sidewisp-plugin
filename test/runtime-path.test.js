import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveManagedRuntime,prepareRuntimeCompanion} from '../src/auth/runtime-companion.js';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-runtime-argv-'));
 const runtime=path.join(root,'runtime'),stateDir=path.join(root,'state');
 fs.mkdirSync(path.join(runtime,'dist'),{recursive:true});fs.mkdirSync(stateDir);
 fs.writeFileSync(path.join(runtime,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.8'}));
 const entry=path.join(runtime,'dist/index.js'),configPath=path.join(stateDir,'openclaw.json');
 fs.writeFileSync(entry,'');fs.writeFileSync(configPath,'{}');
 const serviceStatus={service:{loaded:true,runtime:{status:'running',pid:1},command:{environment:{OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:configPath}}},config:{daemon:{path:configPath}}};
 const resolve=args=>{serviceStatus.service.command.programArguments=args;return resolveManagedRuntime({serviceStatus,stateDir,configPath});};
 return {root,runtime,stateDir,entry,configPath,serviceStatus,resolve,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

for(const [name,prefix] of [
 ['ordinary',['/usr/bin/node']],
 ['canonical memory',['/usr/bin/node','--max-old-space-size=3992']],
 ['separate memory value',['node','--max-old-space-size','3992']],
 ['Node underscore spelling',['node','--max_old_space_size=3992']],
 ['two distinct memory options',['node','--max-old-space-size=3992','--max-semi-space-size','16']],
 ['explicit end of Node options',['node','--max-old-space-size=3992','--']],
])test(name,()=>{const f=fixture();try{assert.equal(f.resolve([...prefix,f.entry,'gateway','--port','12345']),f.runtime);}finally{f.cleanup();}});

for(const [name,make] of [
 ['missing argv',()=>undefined],['missing script',()=>['node','--max-old-space-size=3992']],
 ['relative script',()=>['node','--max-old-space-size=3992','dist/index.js']],
 ['missing memory value',f=>['node','--max-old-space-size',f.entry]],
 ['empty memory value',f=>['node','--max-old-space-size=',f.entry]],
 ['non-numeric memory',f=>['node','--max-old-space-size=oops',f.entry]],
 ['zero memory',f=>['node','--max-old-space-size=0',f.entry]],
 ['negative memory',f=>['node','--max-old-space-size=-1',f.entry]],
 ['unsafe integer memory',f=>['node','--max-old-space-size=9007199254740992',f.entry]],
 ['ambiguous repeated memory',f=>['node','--max-old-space-size=32','--max_old_space_size=64',f.entry]],
 ['eval cannot masquerade as script',f=>['node','--eval',f.entry,f.entry]],
 ['require value is not entrypoint',f=>['node','--require',f.entry,f.entry]],
 ['import value is not entrypoint',f=>['node','--import='+f.entry,f.entry]],
 ['unknown option',f=>['node','--unknown-node-option',f.entry]],
 ['shell launcher',f=>['sh','-c','node '+f.entry]],
 ['non-string argument',f=>['node',42,f.entry]],
 ['nonexistent entrypoint',f=>['node',path.join(f.runtime,'missing.js')]],
 ['directory is not script',f=>['node',f.runtime]],
 ['do not scan later absolute paths',f=>['node','/missing-script.js',f.entry]],
])test('refuses '+name,()=>{const f=fixture();try{assert.throws(()=>f.resolve(make(f)),/runtime_path_unavailable/);}finally{f.cleanup();}});

test('memory parsing cannot weaken active profile and runtime-version checks',()=>{
 const f=fixture();try{
  const args=['node','--max-old-space-size=3992',f.entry];f.serviceStatus.config.mismatch=true;
  assert.throws(()=>f.resolve(args),/managed_active_profile_required/);delete f.serviceStatus.config.mismatch;
  f.serviceStatus.service.command.environment.OPENCLAW_STATE_DIR=f.root;
  assert.throws(()=>f.resolve(args),/managed_active_profile_required/);f.serviceStatus.service.command.environment.OPENCLAW_STATE_DIR=f.stateDir;
  fs.writeFileSync(path.join(f.runtime,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.9'}));
  assert.throws(()=>f.resolve(args),/unsupported_runtime_companion/);
 }finally{f.cleanup();}
});

test('resolved memory prefix still refuses busy host before staging any files',()=>{
 const f=fixture();try{
  f.serviceStatus.service.command.programArguments=['node','--max-old-space-size=3992',f.entry];
  const calls=[];const run=args=>{calls.push(args);return JSON.stringify(args[1]==='status'?f.serviceStatus:{ts:Date.now(),dynamic:null,lanes:[{activeCount:1,queuedCount:0,draining:false,blockedBy:null}]});};
  assert.throws(()=>prepareRuntimeCompanion({run,stateDir:f.stateDir,configPath:f.configPath}),/host_activation_busy/);
  assert.equal(calls.length,2);assert.equal(fs.existsSync(path.join(f.stateDir,'sidewisp')),false);
 }finally{f.cleanup();}
});
