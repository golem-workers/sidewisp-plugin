import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,mkdirSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {shouldApply,updateHeartbeat} from '../src/update/manager.js';
import {installUpdateManager} from '../scripts/install-update-manager.mjs';
const d={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.38',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.38',sha256:'a'.repeat(64),revision:'release-38',mandatory:true,restartDelaySeconds:30};
test('required version converges without downgrade, duplicate launch or repeating failed revision',()=>{
 assert.equal(shouldApply({directive:d,currentVersion:'0.2.37'}),true);
 assert.equal(shouldApply({directive:d,currentVersion:'0.2.38'}),false);
 assert.equal(shouldApply({directive:d,currentVersion:'0.2.40'}),false);
 assert.equal(shouldApply({directive:d,currentVersion:null}),true);
 assert.equal(shouldApply({directive:d,currentVersion:'0.2.37',active:true}),false);
 for(const status of ['failed','rolled_back','completed','skipped','updating','verifying','rolling_back'])assert.equal(shouldApply({directive:d,currentVersion:'0.2.37',attempt:{targetVersion:d.targetVersion,revision:d.revision,status}}),false);
 assert.equal(shouldApply({directive:d,currentVersion:'0.2.37',attempt:{targetVersion:d.targetVersion,revision:d.revision,status:'deferred'}}),true);
 assert.equal(shouldApply({directive:{...d,revision:'retry-approved'},currentVersion:'0.2.37',attempt:{targetVersion:d.targetVersion,revision:d.revision,status:'failed'}}),true);
 assert.equal(shouldApply({directive:{...d,sha256:null},currentVersion:'0.2.37'}),false);
});
test('control heartbeat is signed and rejects redirects, other installation and malformed directives',async()=>{
 const credential={installationId:'sw_ins_testing12345',secret:'test-secret'};
 const report={managerVersion:'0.2.38',currentVersion:'0.2.37',status:'idle'};
 const options={endpoint:'https://staging-api.sidewisp.com',credential,report};
 assert.deepEqual(await updateHeartbeat({...options,fetchImpl:async(url,init)=>{assert.equal(url.pathname,'/v1/installations/update-heartbeat');assert.equal(init.redirect,'error');assert.match(init.headers.authorization,/^Sidewisp sw_ins_testing12345:[a-f0-9]{64}$/);assert.equal(JSON.parse(init.body).schema,'sidewisp.update-heartbeat.v1');return {ok:true,json:async()=>({schema:'sidewisp.update-heartbeat.v1',installationId:credential.installationId,update:d})};}}),d);
 for(const result of [{installationId:'sw_ins_other'},{installationId:credential.installationId,update:{...d,sha256:'bad'}}])await assert.rejects(updateHeartbeat({...options,fetchImpl:async()=>({ok:true,json:async()=>({schema:'sidewisp.update-heartbeat.v1',...result})})}),/INVALID_CONTROL_RESPONSE/);
 await assert.rejects(updateHeartbeat({...options,fetchImpl:async()=>({ok:false,status:401})}),/CREDENTIAL_REJECTED/);
});
test('manager installer creates isolated bundle and profile-scoped service without secrets or Gateway operations',()=>{
 const home=mkdtempSync(path.join(os.tmpdir(),'sw-manager-'));try{
 const stateDir=path.join(home,'state');mkdirSync(stateDir);const calls=[];
 const environment={HOME:home,PATH:'/usr/bin',OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:path.join(stateDir,'openclaw.json'),OPENCLAW_PROFILE:'proof',SECRET_TOKEN:'do-not-copy'};
 const result=installUpdateManager({stateDir,endpoint:'https://staging-api.sidewisp.com',environment,platform:'linux',run:(...a)=>calls.push(a)});
 const unit=readFileSync(path.join(home,'.config/systemd/user',result.unit),'utf8');assert.match(unit,/manager\/current\/scripts\/managed-updater.mjs/);assert.match(unit,/OPENCLAW_PROFILE=proof/);assert.doesNotMatch(unit,/SECRET_TOKEN|do-not-copy|gateway restart/);
 assert.equal(JSON.parse(readFileSync(path.join(stateDir,'sidewisp/manager/current/package.json'),'utf8')).version,'0.2.50');assert.equal(calls.length,2);
 assert.throws(()=>installUpdateManager({stateDir,endpoint:'https://api.sidewisp.com',environment,platform:'linux',run:()=>{}}),/MANAGER_BINDING_MISMATCH/);
 }finally{rmSync(home,{recursive:true,force:true});}
});
