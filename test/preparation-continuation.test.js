import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFileCredentialStore} from '../src/auth/credentials.js';
import {preparationContinuation,notifyPreparationContinuation} from '../src/auth/preparation-continuation.js';
import {beginEndpointTransition} from '../src/auth/endpoint-transition.js';
async function fixture(t){
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-continuation-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const sourceEndpoint='https://same.test',targetEndpoint=sourceEndpoint+':18443',configFile=path.join(stateDir,'config.json');
 await fs.writeFile(configFile,JSON.stringify({plugins:{entries:{sidewisp:{config:{endpoint:sourceEndpoint}}}}}));
 await createFileCredentialStore({stateDir}).write({installationId:'sw_ins_source12345678',secret:'sw_secret_'+'s'.repeat(43),status:'active'});
 await fs.writeFile(path.join(stateDir,'sidewisp/device-authorization.json'),'old authorization bytes');
 const files=[configFile,path.join(stateDir,'sidewisp/installation.json'),path.join(stateDir,'sidewisp/device-authorization.json')],before=await Promise.all(files.map(f=>fs.readFile(f,'utf8')));
 return {stateDir,configFile,sourceEndpoint,targetEndpoint,requestId:'sw_pair_'+'t'.repeat(32),expiresAtMs:Date.now()+60000,preserved:async()=>assert.deepEqual(await Promise.all(files.map(f=>fs.readFile(f,'utf8'))),before)};
}
test('completion creates a reusable private plan but still cannot begin without exact host consent',async t=>{
 const f=await fixture(t);const result=await preparationContinuation(f);assert.equal(result.status,'blocked');assert.equal(result.reason,'existing_endpoint_mismatch');assert.equal(result.nextAction.type,'confirm_endpoint_transition');
 const plan=JSON.parse(await fs.readFile(result.nextAction.planFile,'utf8'));assert.equal((await fs.stat(result.nextAction.planFile)).mode&0o777,0o600);
 let calls=0;await assert.rejects(beginEndpointTransition({plan,confirmation:'not-consent',requestId:f.requestId,fetchImpl:()=>{calls++;}}),/explicit_host_confirmation_required/);assert.equal(calls,0);
 assert.deepEqual(await preparationContinuation(f),result);await f.preserved();assert.doesNotMatch(JSON.stringify(result),/sw_secret_|sw_device_/);
});
test('expiry during source maintenance yields fresh-invitation blocker without creating any transition',async t=>{
 const f=await fixture(t);const result=await preparationContinuation({...f,now:()=>f.expiresAtMs});assert.deepEqual(result,{status:'blocked',bindingPreserved:true,sourceUpdate:'completed',reason:'fresh_invitation_required',nextAction:{type:'fresh_invitation_required'}});await f.preserved();await assert.rejects(fs.access(path.join(f.stateDir,'sidewisp-transitions')),{code:'ENOENT'});
});
test('worker initiates one safe confirmation question on the supplied route without including plan hash or secrets',async t=>{
 const f=await fixture(t),result=await preparationContinuation(f),calls=[];const options={stateDir:f.stateDir,requestId:f.requestId,action:result.nextAction,route:{channel:'telegram',to:'12345',accountId:'default',threadId:'7'},send:async(route,text)=>{calls.push({route,text});return {messageId:'receipt'}}};
 await notifyPreparationContinuation(options);await notifyPreparationContinuation(options);assert.equal(calls.length,1);assert.match(calls[0].text,/Подтвердите/);assert.ok(calls[0].text.includes(f.sourceEndpoint));assert.ok(calls[0].text.includes(f.targetEndpoint));assert.ok(!calls[0].text.includes(result.nextAction.confirmation));assert.doesNotMatch(calls[0].text,/sw_secret_|sw_device_/);assert.equal(calls[0].route.threadId,'7');await f.preserved();
});
test('invalid caller route cannot send a confirmation question',async t=>{
 const f=await fixture(t);let calls=0;await assert.rejects(notifyPreparationContinuation({...f,action:{type:'fresh_invitation_required'},route:{channel:'telegram',to:'untrusted/path'},send:()=>{calls++;}}),/invalid_connection_reply_route/);assert.equal(calls,0);await f.preserved();
});
test('expired confirmed continuation is rejected by real transition CLI before enqueue or network',async t=>{
 const f=await fixture(t),result=await preparationContinuation(f);
 const cli=fileURLToPath(new URL('../scripts/endpoint-transition.mjs',import.meta.url));
 const child=spawnSync(process.execPath,[cli,'connect',result.nextAction.planFile,result.nextAction.confirmation,f.requestId,'--expires-at-ms','1','--enqueue'],{env:{...process.env,OPENCLAW_STATE_DIR:f.stateDir,OPENCLAW_CONFIG_PATH:f.configFile},encoding:'utf8'});
 assert.equal(child.status,1);assert.equal(child.stderr.trim(),'fresh_invitation_required');assert.equal(child.stdout,'');await f.preserved();
});
