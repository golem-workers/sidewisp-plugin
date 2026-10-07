import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
async function fixture({refused=false,updateOnly=false}={}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'sidewisp-cli-result-'));
 try {
  const state=path.join(dir,'state'),bin=path.join(dir,'bin');await mkdir(state);await mkdir(bin);
  const archive=path.join(dir,'archive.tgz');await writeFile(archive,'verified-cli-fixture');
  const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
  const config=path.join(state,'openclaw.json');await writeFile(config,'{}',{mode:0o600});
  const id='sw_pair_'+'x'.repeat(32),expiresAtMs=Date.now()+600000;
  const status={version,endpoint:'https://fixture.sidewisp.test',enabled:true,running:true,connectionReadiness:{ready:true}};
  await writeFile(path.join(bin,'openclaw'),'#!/bin/sh\n'+(refused?'echo "private credential material" >&2\nexit 1\n':`echo '${JSON.stringify(status)}'\n`),{mode:0o700});
  await writeFile(path.join(bin,'systemctl'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const preload=path.join(dir,'preload.mjs'),ledger=path.join(dir,'calls.json');
  await writeFile(preload,`import {writeFileSync} from 'node:fs';let calls=0;globalThis.fetch=async(url,options)=>{if(new URL(url).pathname!=='/v1/device-authorizations/begin')throw Error('unexpected_request');const body=JSON.parse(options.body);if(body.id!==${JSON.stringify(id)} || !body.deviceSecret.startsWith('sw_device_'))throw Error('invalid_begin');writeFileSync(${JSON.stringify(ledger)},JSON.stringify({calls:++calls}));return Response.json({id:body.id,userCode:'ABCDEF1234',expiresAtMs:${expiresAtMs}});};`);
  const result=spawnSync(process.execPath,['--import',preload,path.join(root,'scripts/prepare-openclaw.mjs'),'--archive',archive,'--sha256',sha256,'--endpoint',status.endpoint,'--state-dir',state,...(updateOnly?['--update-only']:['--request-id',id,'--expires-at-ms',String(expiresAtMs)])],{env:{...process.env,HOME:dir,XDG_CONFIG_HOME:path.join(dir,'config'),PATH:bin+path.delimiter+process.env.PATH,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config},encoding:'utf8',timeout:20000});
  const persisted=JSON.parse(await readFile(path.join(state,'sidewisp/prepare-status.json'),'utf8'));
  let calls=0;try{calls=JSON.parse(await readFile(ledger,'utf8')).calls;}catch(e){if(e.code!=='ENOENT')throw e;}
  return {result,persisted,calls,id,expiresAtMs};
 }finally{await rm(dir,{recursive:true,force:true});}
}
test('real preparation CLI reports approval_pending, not empty success or completed connection',async()=>{
 const {result,persisted,calls,id,expiresAtMs}=await fixture();assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{status:'approval_pending',requestId:id,expiresAtMs});
 assert.equal(persisted.status,'approval_pending');assert.equal(calls,1);
 assert.doesNotMatch(result.stdout,/sw_device_|ABCDEF1234|credential|verificationUri/);
});
test('real preparation CLI reports safe refusal without requesting approval or leaking exception text',async()=>{
 const {result,persisted,calls}=await fixture({refused:true});assert.equal(result.status,1);
 assert.deepEqual(JSON.parse(result.stdout),{status:'blocked',reason:'preparation_failed'});
 assert.equal(persisted.status,'blocked');assert.equal(calls,0);assert.doesNotMatch(result.stdout+result.stderr,/private credential material/);
});
test('update-only CLI reports terminal completion without an authorization request',async()=>{
 const {result,persisted,calls}=await fixture({updateOnly:true});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{status:'completed'});assert.equal(persisted.status,'completed');assert.equal(calls,0);
});
