import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';

for(const variant of ['expired-during-status','plain-401','network','wrong-installation','rejected-with-200','binding-active-again'])test(`invitation continuation preserves old binding on ${variant}`,async t=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'continue-guard-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const file=path.join(stateDir,'sidewisp/installation.json'),old={installationId:'sw_ins_old12345678',secret:'sw_secret_'+'o'.repeat(43),status:'active'},bytes=JSON.stringify(old);
 await fs.mkdir(path.dirname(file));await fs.writeFile(file,bytes,{mode:0o600});
 let now=1000;const routes=[];
 const client=createDeviceAuthorizationClient({endpoint:'https://fixture.test',stateDir,fetchImpl:async(url)=>{
  routes.push(url.pathname);assert.equal(url.pathname,'/v1/installations/credential-status');
  if(variant==='network')throw Error('network_unavailable');
  if(variant==='binding-active-again')return Response.json({schema:'sidewisp.credential-status.v1',status:routes.length===1?'rejected':'active',installationId:old.installationId},{status:routes.length===1?401:200});
  if(variant==='expired-during-status'){now=2000;return Response.json({schema:'sidewisp.credential-status.v1',status:'rejected'},{status:401});}
  if(variant==='plain-401')return Response.json({error:'login_required'},{status:401});
  return Response.json({schema:'sidewisp.credential-status.v1',status:variant==='wrong-installation'?'active':'rejected',installationId:'sw_ins_other12345678'});
 }});
 await assert.rejects(client.continueInvitation({id:'sw_pair_'+'i'.repeat(32),runtime:'openclaw',expiresAtMs:2000,now:()=>now}));
 assert.deepEqual(routes,Array(variant==='binding-active-again'?2:1).fill('/v1/installations/credential-status'));assert.equal(await fs.readFile(file,'utf8'),bytes);
 await assert.rejects(fs.stat(path.join(stateDir,'sidewisp/device-authorization.json')),{code:'ENOENT'});
});
