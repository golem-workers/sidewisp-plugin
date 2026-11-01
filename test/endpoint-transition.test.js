import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {planEndpointTransition,beginEndpointTransition,pollEndpointTransition,verifyEndpointTransitionReady} from '../src/auth/endpoint-transition.js';
import {createFileCredentialStore} from '../src/auth/credentials.js';
async function fixture(t){
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-transition-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const configFile=path.join(stateDir,'openclaw.json');await fs.writeFile(configFile,JSON.stringify({plugins:{entries:{sidewisp:{config:{endpoint:'https://staging-api.sidewisp.com'}}}},other:'keep'}));
 await createFileCredentialStore({stateDir}).write({installationId:'sw_ins_old12345678',secret:'sw_secret_'+'o'.repeat(43),status:'active'});
 await fs.writeFile(path.join(stateDir,'sidewisp','spool.sqlite'),'untouched-backlog-and-cursors');
 const before=await Promise.all(['openclaw.json','sidewisp/installation.json','sidewisp/spool.sqlite'].map(n=>fs.readFile(path.join(stateDir,n),'utf8')));
 const assertPreserved=async()=>assert.deepEqual(await Promise.all(['openclaw.json','sidewisp/installation.json','sidewisp/spool.sqlite'].map(n=>fs.readFile(path.join(stateDir,n),'utf8'))),before);
 return {stateDir,configFile,assertPreserved};
}
test('no request before host confirmation; source changes invalidate exact plan',async t=>{
 const f=await fixture(t),plan=await planEndpointTransition(f);let calls=0;
 await assert.rejects(beginEndpointTransition({plan,confirmation:'no',requestId:'sw_pair_'+'a'.repeat(32),fetchImpl:()=>{calls++;}}),/explicit_host_confirmation_required/);
 assert.equal(calls,0);await f.assertPreserved();
 await fs.appendFile(f.configFile,' ');
 await assert.rejects(beginEndpointTransition({plan,confirmation:plan.confirmation,fetchImpl:()=>{calls++;}}),/source_profile_changed/);assert.equal(calls,0);
});
test('new authorization uses isolated proof and approval/ACK; original credentials and backlog remain unchanged',async t=>{
 const f=await fixture(t),plan=await planEndpointTransition(f),id='sw_pair_'+'a'.repeat(32);let approved=false,proof;
 const fetchImpl=async(url,options)=>{
  if(url.pathname.endsWith('/credential-status')){
   const stage=url.origin==='https://staging-api.sidewisp.com';
   if(!stage)assert.equal(options.headers.authorization.includes('sw_ins_old12345678'),false);
   return {status:200,json:async()=>({schema:'sidewisp.credential-status.v1',status:'active',installationId:stage?'sw_ins_old12345678':'sw_ins_new12345678'})};
  }
  assert.equal(url.origin,'https://api.sidewisp.com');assert.equal(JSON.stringify(options).includes('sw_secret_'+'o'.repeat(43)),false);
  const input=JSON.parse(options.body);proof??=input.deviceSecret;assert.equal(input.deviceSecret,proof);
  if(url.pathname.endsWith('/begin'))return {ok:true,json:async()=>({id,userCode:'12345ABCDE',expiresAtMs:Date.now()+60000})};
  return {ok:true,json:async()=>input.acknowledge?{status:'completed'}:approved?{status:'approved',credential:{installationId:'sw_ins_new12345678',installationSecret:'sw_secret_'+'n'.repeat(43)}}:{status:'pending'}};
 };
 assert.equal((await beginEndpointTransition({plan,confirmation:plan.confirmation,requestId:id,fetchImpl})).status,'pending');await f.assertPreserved();
 assert.equal((await pollEndpointTransition({plan,fetchImpl})).status,'pending');
 await assert.rejects(verifyEndpointTransitionReady({plan,fetchImpl}),/new_production_authorization_required/);
 approved=true;assert.equal((await pollEndpointTransition({plan,fetchImpl})).status,'credential_saved');await f.assertPreserved();
 const ready=await verifyEndpointTransitionReady({plan,fetchImpl});assert.equal(ready.bindingChanged,false);assert.equal(JSON.stringify(ready).includes(proof),false);
});
test('unavailable staging status never authorizes a new request or changes the source',async t=>{
 const f=await fixture(t),plan=await planEndpointTransition(f);let calls=0;
 await assert.rejects(beginEndpointTransition({plan,confirmation:plan.confirmation,requestId:'sw_pair_'+'b'.repeat(32),fetchImpl:async()=>{calls++;throw Error('unavailable');}}),/unavailable/);
 assert.equal(calls,1);await f.assertPreserved();
});

import {activateEndpointTransition} from '../src/auth/endpoint-transition.js';
async function staged(t) {
 const f=await fixture(t),plan=await planEndpointTransition({...f,sourceEndpoint:'https://source.test',targetEndpoint:'https://target.test'}).catch(async()=>{
  const config=JSON.parse(await fs.readFile(f.configFile));config.plugins.entries.sidewisp.config.endpoint='https://source.test';await fs.writeFile(f.configFile,JSON.stringify(config));return planEndpointTransition({...f,sourceEndpoint:'https://source.test',targetEndpoint:'https://target.test'});
 });
 await createFileCredentialStore({stateDir:plan.candidateStateDir}).write({installationId:'sw_ins_new12345678',secret:'sw_secret_'+'n'.repeat(43),status:'active'});
 const fetchImpl=async u=>({status:200,json:async()=>({schema:'sidewisp.credential-status.v1',status:'active',installationId:u.origin===plan.sourceEndpoint?'sw_ins_old12345678':'sw_ins_new12345678'})});
 const before=await fs.readFile(f.configFile),credential=await fs.readFile(path.join(f.stateDir,'sidewisp/installation.json'));
 return {...f,plan,fetchImpl,before,credential};
}
test('explicit arbitrary HTTPS endpoint pair is bound to the exact immutable plan',async t=>{
 const f=await staged(t);assert.equal(f.plan.targetEndpoint,'https://target.test');
 for(const targetEndpoint of ['http://target.test','https://u:p@target.test','https://target.test/a',f.plan.sourceEndpoint])await assert.rejects(planEndpointTransition({...f,targetEndpoint,sourceEndpoint:f.plan.sourceEndpoint}));
});
test('host busy refuses activation before any state is changed',async t=>{
 const f=await staged(t);let stopped=false;
 await assert.rejects(activateEndpointTransition({...f,confirmation:f.plan.confirmation,host:{validate:async()=>{},suspend:async()=>{throw Error('busy')},stop:async()=>{stopped=true;}}}),/busy/);
 assert.equal(stopped,false);assert.deepEqual(await fs.readFile(f.configFile),f.before);assert.deepEqual(await fs.readFile(path.join(f.stateDir,'sidewisp/installation.json')),f.credential);
});
test('activation archives source spool/credentials and gives destination a clean store; repeated activation is idempotent',async t=>{
 const f=await staged(t),events=[];const host={validate:async()=>events.push('validate'),suspend:async()=>{events.push('suspend');return 'lease'},stop:async()=>events.push('stop'),start:async endpoint=>events.push(endpoint)};
 const options={...f,confirmation:f.plan.confirmation,host};const result=await activateEndpointTransition(options);assert.equal(result.status,'activated');assert.equal(result.sourceArchived,true);
 const root=path.dirname(f.plan.candidateStateDir);assert.deepEqual(await fs.readFile(path.join(root,'source-sidewisp/installation.json')),f.credential);
 assert.equal(await fs.readFile(path.join(root,'source-sidewisp/spool.sqlite'),'utf8'),'untouched-backlog-and-cursors');
 await assert.rejects(fs.access(path.join(f.stateDir,'sidewisp/spool.sqlite')),{code:'ENOENT'});
 assert.equal((await createFileCredentialStore({stateDir:f.stateDir}).read()).installationId,'sw_ins_new12345678');
 assert.equal(JSON.parse(await fs.readFile(f.configFile)).other,'keep');assert.equal(events.at(-1),'https://target.test');
 const n=events.length;await activateEndpointTransition(options);assert.equal(events.length,n);
});
test('failed destination start restores original config, credential, spool and source service',async t=>{
 const f=await staged(t);let restored=false;const host={validate:async()=>{},suspend:async()=> 'lease',stop:async()=>{},start:async endpoint=>{if(endpoint===f.plan.targetEndpoint)throw Error('target_failed');restored=true;}};
 await assert.rejects(activateEndpointTransition({...f,confirmation:f.plan.confirmation,host}),/target_failed/);assert.equal(restored,true);
 assert.deepEqual(await fs.readFile(f.configFile),f.before);assert.deepEqual(await fs.readFile(path.join(f.stateDir,'sidewisp/installation.json')),f.credential);
 assert.equal(await fs.readFile(path.join(f.stateDir,'sidewisp/spool.sqlite'),'utf8'),'untouched-backlog-and-cursors');
});
test('an already-reported invitation reuses its proof without copying source credentials',async t=>{
 const f=await fixture(t),plan=await planEndpointTransition(f),id='sw_pair_'+'p'.repeat(32),proof='sw_device_'+'x'.repeat(43);
 const dir=path.join(f.stateDir,'sidewisp/prepare-authorizations');await fs.mkdir(dir);await fs.writeFile(path.join(dir,id+'.json'),JSON.stringify({id,runtime:'openclaw',endpoint:plan.targetEndpoint,deviceSecret:proof}));
 await beginEndpointTransition({plan,confirmation:plan.confirmation,requestId:id,fetchImpl:async(u,o)=>u.pathname.endsWith('credential-status')?{status:200,json:async()=>({schema:'sidewisp.credential-status.v1',status:'active',installationId:plan.sourceInstallationId})}:(assert.equal(JSON.parse(o.body).deviceSecret,proof),{ok:true,json:async()=>({id,userCode:'12345ABCDE'})})});
 await f.assertPreserved();assert.equal(await createFileCredentialStore({stateDir:plan.candidateStateDir}).read(),null);
});
