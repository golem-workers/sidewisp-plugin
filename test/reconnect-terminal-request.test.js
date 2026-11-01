import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
for(const [status,reason,terminal] of [[401,'request_rejected',true],[401,'invalid_device_proof',true],[404,'authorization_not_found',true],[401,'unauthorized',false],[404,'not_found',false],[503,'request_rejected',false]]) {
 test(`stale saved request ${status}/${reason}: terminal=${terminal}`,async t=>{
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sidewisp-old-request-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const file=path.join(stateDir,'sidewisp/device-authorization.json'),old={endpoint:'https://example.com',id:'sw_pair_'+ 'a'.repeat(32),runtime:'openclaw',deviceSecret:'sw_device_'+ 's'.repeat(43)};
  await fs.mkdir(path.dirname(file));await fs.writeFile(file,JSON.stringify(old));
  let begins=0;
  const client=createDeviceAuthorizationClient({endpoint:old.endpoint,stateDir,fetchImpl:async(url,opts)=>{
   if(url.pathname.endsWith('/poll'))return {ok:false,status,json:async()=>({error:reason})};
   begins++;const body=JSON.parse(opts.body);return {ok:true,json:async()=>({id:body.id,userCode:'ABCDEF1234',expiresAtMs:Date.now()+60000})};
  }});
  const run=()=>client.begin({id:'sw_pair_'+ 'b'.repeat(32),runtime:'openclaw'});
  if(terminal){assert.equal((await run()).status,'pending');assert.equal(begins,1);assert.notEqual(JSON.parse(await fs.readFile(file)).id,old.id);}
  else {await assert.rejects(run(),/device_authorization_http_/);assert.deepEqual(JSON.parse(await fs.readFile(file)),old);assert.equal(begins,0);}
 });
}
