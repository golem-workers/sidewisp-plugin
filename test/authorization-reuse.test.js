import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
async function fixture(work){const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'reuse-client-'));try{const directory=path.join(stateDir,'sidewisp');await fs.mkdir(directory);const credential={installationId:'sw_ins_existing12345',secret:'sw_secret_'+'a'.repeat(43),status:'active'};await fs.writeFile(path.join(directory,'installation.json'),JSON.stringify(credential),{mode:0o600});const id='sw_pair_'+'a'.repeat(32),expiresAtMs=10000;await fs.mkdir(path.join(directory,'prepare-authorizations'));await fs.writeFile(path.join(directory,'prepare-authorizations',id+'.json'),JSON.stringify({id,runtime:'openclaw',endpoint:'https://same.test',deviceSecret:'sw_device_'+'b'.repeat(43)}),{mode:0o600});await work({stateDir,directory,credential,id,expiresAtMs});}finally{await fs.rm(stateDir,{recursive:true,force:true});}}
for(const variant of ['wrong-request','wrong-installation','wrong-expiry','unsupported','expired','credential-changed','wrong-proof-endpoint'])test(`reuse client cannot accept ${variant}`,async()=>fixture(async f=>{
 let now=1000,calls=0;const before=await fs.readFile(path.join(f.directory,'installation.json'),'utf8');
 if(variant==='wrong-proof-endpoint'){const p=path.join(f.directory,'prepare-authorizations',f.id+'.json'),row=JSON.parse(await fs.readFile(p,'utf8'));row.endpoint='https://other.test';await fs.writeFile(p,JSON.stringify(row));}
 const fetchImpl=async(u,o)=>{calls++;assert.equal(u.origin,'https://same.test');assert.equal(u.pathname,'/v1/device-authorizations/reuse');assert.ok(o.headers.authorization.startsWith('Sidewisp '+f.credential.installationId+':'));assert.ok(!o.body.toString().includes(f.credential.secret));
  if(variant==='unsupported')return Response.json({error:'not_found'},{status:404});
  const row={id:f.id,installationId:f.credential.installationId,reusedExistingInstallation:true,status:'completed',expiresAtMs:f.expiresAtMs};
  if(variant==='wrong-request')row.id='sw_pair_'+'x'.repeat(32);if(variant==='wrong-installation')row.installationId='sw_ins_foreign';if(variant==='wrong-expiry')row.expiresAtMs++;if(variant==='credential-changed'){await fs.writeFile(path.join(f.directory,'installation.json'),JSON.stringify({...f.credential,secret:'changed'}));row.status='approved';}return Response.json(row);
 };
 const client=createDeviceAuthorizationClient({endpoint:'https://same.test',stateDir:f.stateDir,fetchImpl});
 await assert.rejects(client.reuseExisting({id:f.id,runtime:'openclaw',expiresAtMs:variant==='expired'?1000:f.expiresAtMs,now:()=>now,sleep:async()=>{now++;}}));
 await assert.rejects(fs.stat(path.join(f.directory,'authorization-completed.json')),{code:'ENOENT'});
 if(variant!=='credential-changed')assert.equal(await fs.readFile(path.join(f.directory,'installation.json'),'utf8'),before);
 if(['expired','wrong-proof-endpoint'].includes(variant))assert.equal(calls,0);
}));
