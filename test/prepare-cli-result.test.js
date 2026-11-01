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
async function fixture({refused=false,updateOnly=false,queueRefused=false,reportTarget=false,foreignAuthorization=false,extraArgs=[]}={}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'sidewisp-cli-result-'));
 try {
  const state=path.join(dir,'state'),bin=path.join(dir,'bin');await mkdir(state);await mkdir(bin);
  const archive=path.join(dir,'archive.tgz');await writeFile(archive,'verified-cli-fixture');
  const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
  const config=path.join(state,'openclaw.json');await writeFile(config,'{}',{mode:0o600});
  const id='sw_pair_'+'x'.repeat(32),expiresAtMs=Date.now()+600000;
  const targetEndpoint='https://fixture.sidewisp.test:18443';
  const oldAuthorization=JSON.stringify({id:'sw_pair_'+'o'.repeat(32),runtime:'openclaw',endpoint:'https://fixture.sidewisp.test',deviceSecret:'sw_device_'+'o'.repeat(43)});
  const oldCredential=JSON.stringify({installationId:'sw_ins_old12345678',secret:'sw_secret_'+'o'.repeat(43),status:'active'});
  if(foreignAuthorization){await mkdir(path.join(state,'sidewisp'),{recursive:true});await writeFile(path.join(state,'sidewisp/device-authorization.json'),oldAuthorization,{mode:0o600});await writeFile(path.join(state,'sidewisp/installation.json'),oldCredential,{mode:0o600});}
  const status={version,endpoint:'https://fixture.sidewisp.test',enabled:true,running:true,connectionReadiness:{ready:true}};
  const runtime=path.join(dir,'runtime-hotfix');const extracted=spawnSync('tar',['-xzf',path.join(root,'runtime/openclaw-2026.9.8-reply-observer.5.tgz'),'-C',dir]);assert.equal(extracted.status,0);
  await writeFile(path.join(runtime,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.8'}));await writeFile(path.join(runtime,'openclaw.mjs'),'');
  await mkdir(path.join(state,'sidewisp/runtime-companion-4013'),{recursive:true});await writeFile(path.join(state,'sidewisp/runtime-companion-4013/result.json'),JSON.stringify({phase:'completed',version:'2026.9.8-reply-observer.5'}));
  const service={service:{loaded:true,runtime:{status:'running',pid:1},command:{programArguments:[process.execPath,path.join(runtime,'openclaw.mjs')],environment:{OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config}}},config:{daemon:{path:config},mismatch:false}};
  const lanes={ts:Date.now(),dynamic:null,lanes:[{activeCount:0,queuedCount:0}]};
  await writeFile(path.join(bin,'openclaw'),'#!/bin/sh\n'+(refused?'echo "private credential material" >&2\nexit 1\n':`case "$*" in *"status --no-probe"*) echo '${JSON.stringify(service)}';; *"diagnostics.lanes"*) echo '${JSON.stringify(lanes)}';; *) echo '${JSON.stringify(status)}';; esac\n`),{mode:0o700});
  await writeFile(path.join(bin,'systemctl'),queueRefused?'#!/bin/sh\necho \"private queue credential material\" >&2\nexit 1\n':'#!/bin/sh\nexit 0\n',{mode:0o700});
  const preload=path.join(dir,'preload.mjs'),ledger=path.join(dir,'calls.json');
  await writeFile(preload,`import {writeFileSync} from 'node:fs';let calls=0;const reports=[];globalThis.fetch=async(url,options)=>{if(new URL(url).pathname==='/v1/device-authorizations/preparation'){if(options.headers.authorization)throw Error('source_credential_leaked');const body=JSON.parse(options.body);reports.push({origin:new URL(url).origin,id:body.id,stage:body.stage,...(body.reasonCode?{reasonCode:body.reasonCode}:{}),proofPresent:/^sw_device_[A-Za-z0-9_-]{43}$/.test(body.deviceSecret)});writeFileSync(${JSON.stringify(path.join(dir,'reports.json'))},JSON.stringify(reports));writeFileSync(${JSON.stringify(path.join(dir,'report.json'))},JSON.stringify({stage:body.stage,reasonCode:body.reasonCode}));return Response.json({});}if(new URL(url).pathname!=='/v1/device-authorizations/begin')throw Error('unexpected_request');const body=JSON.parse(options.body);if(body.id!==${JSON.stringify(id)} || !body.deviceSecret.startsWith('sw_device_'))throw Error('invalid_begin');writeFileSync(${JSON.stringify(ledger)},JSON.stringify({calls:++calls}));return Response.json({id:body.id,userCode:'ABCDEF1234',expiresAtMs:${expiresAtMs}});};`);
  const result=spawnSync(process.execPath,['--import',preload,path.join(root,'scripts/prepare-openclaw.mjs'),...(queueRefused?['--enqueue']:[]),'--archive',archive,'--sha256',sha256,'--endpoint',status.endpoint,'--state-dir',state,...(updateOnly?['--update-only',...(reportTarget?['--preparation-endpoint',targetEndpoint,'--request-id',id]:[])]:['--request-id',id,'--expires-at-ms',String(expiresAtMs)]),...extraArgs],{env:{...process.env,HOME:dir,XDG_CONFIG_HOME:path.join(dir,'config'),PATH:bin+path.delimiter+process.env.PATH,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config},encoding:'utf8',timeout:20000});
  let persisted;try{persisted=JSON.parse(await readFile(path.join(state,'sidewisp/prepare-status.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let calls=0;try{calls=JSON.parse(await readFile(ledger,'utf8')).calls;}catch(e){if(e.code!=='ENOENT')throw e;}
  let report;try{report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let diagnostics; if(persisted?.failure?.diagnosticId){const {stat}=await import('node:fs/promises');const file=path.join(state,'sidewisp/preparation-diagnostics',persisted.failure.diagnosticId+'.json');diagnostics={body:JSON.parse(await readFile(file,'utf8')),mode:(await stat(file)).mode&0o777};}
  let reports=[];try{reports=JSON.parse(await readFile(path.join(dir,'reports.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const preserved=foreignAuthorization && (await readFile(path.join(state,'sidewisp/device-authorization.json'),'utf8')===oldAuthorization && await readFile(path.join(state,'sidewisp/installation.json'),'utf8')===oldCredential && await readFile(config,'utf8')==='{}');
  let proofMode;try{const {stat}=await import('node:fs/promises');proofMode=(await stat(path.join(state,'sidewisp/prepare-authorizations',id+'.json'))).mode&0o777;}catch(e){if(e.code!=='ENOENT')throw e;}
  return {result,persisted,calls,id,expiresAtMs,report,diagnostics,reports,preserved,proofMode,targetEndpoint};
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

test('queue admission failure reaches server preparation without begin, fallback or private exception text',async()=>{
 const {result,persisted,calls,report}=await fixture({queueRefused:true});assert.equal(result.status,1,result.stderr);
 assert.deepEqual(JSON.parse(result.stdout),{status:'blocked',reason:'preparation_failed'});
 assert.deepEqual(report,{stage:'blocked',reasonCode:'preparation_failed'});assert.equal(persisted.status,'blocked');assert.equal(calls,0);
 assert.doesNotMatch(result.stdout+result.stderr,/private queue credential material|sw_device_/);
});

test('failed RPC retains original stderr privately with the failing step, without protocol leakage',async()=>{const f=await fixture({refused:true});assert.equal(f.diagnostics.mode,0o600);assert.equal(f.diagnostics.body.step,'inspecting');assert.equal(f.diagnostics.body.code,'COMMAND_FAILED');assert.match(f.diagnostics.body.stderr,/private credential material/);assert.doesNotMatch(f.result.stdout+f.result.stderr+JSON.stringify(f.report)+JSON.stringify(f.persisted),/private credential material/);});


test('update-only reports target invitation before source maintenance and stops for explicit transition confirmation',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,foreignAuthorization:true});
 assert.equal(f.result.status,0,f.result.stderr);assert.deepEqual(JSON.parse(f.result.stdout),{status:'completed'});
 assert.equal(f.calls,0);assert.equal(f.preserved,true);assert.equal(f.proofMode,0o600);
 assert.ok(f.reports.length>=3);assert.equal(f.reports[0].stage,'inspecting');
 assert.deepEqual(f.reports.at(-1),{origin:f.targetEndpoint,id:f.id,stage:'blocked',reasonCode:'existing_endpoint_mismatch',proofPresent:true});
 for(const r of f.reports){assert.equal(r.origin,f.targetEndpoint);assert.equal(r.id,f.id);assert.equal(r.proofPresent,true);}
 assert.equal(f.persisted.status,'completed');
 assert.doesNotMatch(f.result.stdout+f.result.stderr,/sw_device_|sw_secret_|ABCDEF1234/);
});


test('progress endpoint rejects noncanonical URLs and use outside update-only before side effects',async()=>{
 const cases=[
  {updateOnly:false,extraArgs:['--preparation-endpoint','https://target.test']},
  {updateOnly:true,extraArgs:['--preparation-endpoint','https://target.test']},
  {updateOnly:true,extraArgs:['--preparation-endpoint']},
  ...['http://target.test','https://target.test/path','https://user:pass@target.test','https://target.test#hash'].map(url=>({updateOnly:true,reportTarget:true,extraArgs:['--preparation-endpoint',url]})),
  {updateOnly:true,reportTarget:true,extraArgs:['--request-id','invalid-id']},
 ];
 for(const options of cases){const f=await fixture(options);assert.equal(f.result.status,1);assert.match(f.result.stderr,/invalid_prepare_input/);assert.equal(f.persisted,undefined);assert.equal(f.calls,0);assert.deepEqual(f.reports,[]);}
});
