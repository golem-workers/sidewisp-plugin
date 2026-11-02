import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createFileCredentialStore} from '../src/auth/credentials.js';
import {invitationTransitionConsent,bindInvitationTransitionPlan} from '../src/auth/invitation-transition.js';
import {planEndpointTransition,beginEndpointTransition} from '../src/auth/endpoint-transition.js';
async function fixture(t){
 const stateDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sw-invitation-')));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const configFile=path.join(stateDir,'openclaw.json'),sourceEndpoint='https://staging-api.sidewisp.com',targetEndpoint='https://api.sidewisp.com';
 await fs.writeFile(configFile,JSON.stringify({plugins:{entries:{sidewisp:{config:{endpoint:sourceEndpoint}}}}}));
 await createFileCredentialStore({stateDir}).write({installationId:'sw_ins_source12345678',secret:'sw_secret_'+'o'.repeat(43),status:'active'});
 return {stateDir,configFile,sourceEndpoint,targetEndpoint,requestId:'sw_pair_'+'a'.repeat(32),expiresAtMs:Date.now()+600000};
}
test('consent is bound to exact origins, request, original expiry and current source profile',async t=>{
 const f=await fixture(t),consent=await invitationTransitionConsent(f);
 assert.deepEqual(await invitationTransitionConsent(f),consent);
 assert.equal((await fs.stat(consent.file)).mode&0o777,0o600);assert.doesNotMatch(await fs.readFile(consent.file,'utf8'),/sw_secret_/);
 for(const targetEndpoint of ['https://api.sidewisp.com:18443','https://api.sidewisp.com/','https://other.test','http://api.sidewisp.com'])await assert.rejects(invitationTransitionConsent({...f,targetEndpoint}),/endpoint_refused/);
 await assert.rejects(invitationTransitionConsent({...f,expiresAtMs:f.expiresAtMs+1}),/consent_mismatch/);
 await assert.rejects(invitationTransitionConsent({...f,now:()=>f.expiresAtMs}),/fresh_invitation_required/);
 await createFileCredentialStore({stateDir:f.stateDir}).write({installationId:'sw_ins_other12345678',secret:'sw_secret_'+'n'.repeat(43),status:'active'});
 await assert.rejects(invitationTransitionConsent(f),/source_profile_changed/);
});
test('completed invitation is repeatable even after expiry without changing destination data',async t=>{
 const f=await fixture(t),consent=await invitationTransitionConsent(f),plan=await planEndpointTransition({...f,invitation:{requestId:f.requestId,expiresAtMs:f.expiresAtMs}}),planFile=path.join(path.dirname(plan.candidateStateDir),'plan.json');
 await fs.mkdir(path.dirname(planFile),{recursive:true});await fs.writeFile(planFile,JSON.stringify(plan));await bindInvitationTransitionPlan({consent,planFile,plan});
 const config=JSON.parse(await fs.readFile(f.configFile));config.plugins.entries.sidewisp.config.endpoint=f.targetEndpoint;await fs.writeFile(f.configFile,JSON.stringify(config));
 await createFileCredentialStore({stateDir:f.stateDir}).write({installationId:'sw_ins_target12345678',secret:'sw_secret_'+'n'.repeat(43),status:'active'});
 await fs.writeFile(path.join(path.dirname(planFile),'activation.json'),JSON.stringify({status:'activated',targetInstallationId:'sw_ins_target12345678'}));
 assert.equal((await invitationTransitionConsent({...f,now:()=>f.expiresAtMs+1})).result.status,'activated');
 await fs.writeFile(path.join(path.dirname(planFile),'activation.json'),JSON.stringify({status:'recovery_required'}));
 await assert.rejects(invitationTransitionConsent(f),/transition_recovery_required/);
});
test('server original expiry must match before any credential collection or activation',async t=>{
 const f=await fixture(t),plan=await planEndpointTransition(f);let targetCalls=0;
 const fetchImpl=async(u)=>u.origin===f.sourceEndpoint?Response.json({schema:'sidewisp.credential-status.v1',status:'active',installationId:plan.sourceInstallationId}):(targetCalls++,Response.json({id:f.requestId,userCode:'12345ABCDE',expiresAtMs:f.expiresAtMs+1}));
 const before=await fs.readFile(path.join(f.stateDir,'sidewisp/installation.json'));
 await assert.rejects(beginEndpointTransition({...f,plan,confirmation:plan.confirmation,fetchImpl}),/invitation_expiry_mismatch/);
 assert.equal(targetCalls,1);assert.deepEqual(await fs.readFile(path.join(f.stateDir,'sidewisp/installation.json')),before);
});

test('each invitation gets a separate candidate even with an unchanged source binding',async t=>{
 const f=await fixture(t);const first=await planEndpointTransition({...f,invitation:{requestId:f.requestId,expiresAtMs:f.expiresAtMs}});
 const second=await planEndpointTransition({...f,invitation:{requestId:'sw_pair_'+'b'.repeat(32),expiresAtMs:f.expiresAtMs}});
 assert.notEqual(first.candidateStateDir,second.candidateStateDir);
 await assert.rejects(beginEndpointTransition({...f,plan:second,confirmation:second.confirmation}),/consent_mismatch/);
});
