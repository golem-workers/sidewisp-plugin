import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beginEndpointTransition,pollEndpointTransition,activateEndpointTransition} from '../src/auth/endpoint-transition.js';
import {createConnectionNotifier,createRuntimeTelegramSender} from '../src/auth/connection-notice.js';
import {createFileCredentialStore} from '../src/auth/credentials.js';
import {createUploader} from '../src/delivery/uploader.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
async function fixture({refused=false,updateOnly=false,queueRefused=false,reportTarget=false,foreignAuthorization=false,extraArgs=[],invitationConsent=false,queued=false,seedReply=false,sameProduction=false,reuseRejected=false,implicitSameOrigin=false,credentialStatus='active',exercise}={}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'sidewisp-cli-result-'));
 try {
  const state=path.join(dir,'state'),bin=path.join(dir,'bin');await mkdir(state);await mkdir(bin);
  const archive=path.join(dir,'archive.tgz');await writeFile(archive,'verified-cli-fixture');
  const sha256=createHash('sha256').update(await readFile(archive)).digest('hex');
  const sourceEndpoint=invitationConsent?'https://staging-api.sidewisp.com':'https://fixture.sidewisp.test';
  const config=path.join(state,'openclaw.json'),configBytes=foreignAuthorization?JSON.stringify({plugins:{entries:{sidewisp:{config:{endpoint:sourceEndpoint}}}}}):'{}';await writeFile(config,configBytes,{mode:0o600});
  const id='sw_pair_'+'x'.repeat(32),expiresAtMs=Date.now()+600000;
  const targetEndpoint=sameProduction?sourceEndpoint:invitationConsent?'https://api.sidewisp.com':'https://fixture.sidewisp.test:18443';
  const oldAuthorization=JSON.stringify({id:'sw_pair_'+'o'.repeat(32),runtime:'openclaw',endpoint:sourceEndpoint,deviceSecret:'sw_device_'+'o'.repeat(43)});
  const oldCredential=JSON.stringify({installationId:'sw_ins_old12345678',secret:'sw_secret_'+'o'.repeat(43),status:'active'});
  if(foreignAuthorization){await mkdir(path.join(state,'sidewisp'),{recursive:true});await writeFile(path.join(state,'sidewisp/device-authorization.json'),oldAuthorization,{mode:0o600});await writeFile(path.join(state,'sidewisp/installation.json'),oldCredential,{mode:0o600});}
  if(seedReply)await writeFile(path.join(state,'sidewisp/connection-reply.json'),JSON.stringify({endpoint:targetEndpoint,requestId:'sw_pair_'+'o'.repeat(32),route:{channel:'telegram',target:'999',accountId:'old',threadId:'1'}}),{mode:0o600});
  const status={version,endpoint:sourceEndpoint,enabled:true,running:true,connectionReadiness:{ready:true}};
  const runtime=path.join(dir,'runtime-hotfix');const extracted=spawnSync('tar',['-xzf',path.join(root,'runtime/openclaw-2026.9.8-reply-observer.5.tgz'),'-C',dir]);assert.equal(extracted.status,0);
  await writeFile(path.join(runtime,'package.json'),JSON.stringify({name:'openclaw',version:'2026.9.8'}));await writeFile(path.join(runtime,'openclaw.mjs'),'');
  await mkdir(path.join(state,'sidewisp/runtime-companion-4013'),{recursive:true});await writeFile(path.join(state,'sidewisp/runtime-companion-4013/result.json'),JSON.stringify({phase:'completed',version:'2026.9.8-reply-observer.5'}));
  const service={service:{loaded:true,runtime:{status:'running',pid:1},command:{programArguments:[process.execPath,path.join(runtime,'openclaw.mjs')],environment:{OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config}}},config:{daemon:{path:config},mismatch:false}};
  const lanes={ts:Date.now(),dynamic:null,lanes:[{activeCount:0,queuedCount:0}]};
  await writeFile(path.join(bin,'openclaw'),'#!/bin/sh\n'+(refused?'echo "private credential material" >&2\nexit 1\n':`case "$*" in *"status --no-probe"*) echo '${JSON.stringify(service)}';; *"diagnostics.lanes"*) echo '${JSON.stringify(lanes)}';; *) echo '${JSON.stringify(status)}';; esac\n`),{mode:0o700});
  await writeFile(path.join(bin,'systemctl'),queueRefused?'#!/bin/sh\necho \"private queue credential material\" >&2\nexit 1\n':'#!/bin/sh\nexit 0\n',{mode:0o700});
  await writeFile(path.join(bin,'loginctl'),'#!/bin/sh\necho yes\n',{mode:0o700});
  await writeFile(path.join(bin,'systemd-run'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const preload=path.join(dir,'preload.mjs'),ledger=path.join(dir,'calls.json');
  await writeFile(preload,`import {writeFileSync} from 'node:fs';let calls=0;const reports=[];globalThis.fetch=async(url,options)=>{if(new URL(url).pathname==='/v1/installations/credential-status'){return Response.json({schema:'sidewisp.credential-status.v1',status:${JSON.stringify(credentialStatus)},installationId:'sw_ins_old12345678'},{status:${credentialStatus==='active'?200:401}});}if(new URL(url).pathname==='/v1/device-authorizations/poll')return Response.json({status:'expired'});if(new URL(url).pathname==='/v1/device-authorizations/reuse'){const b=JSON.parse(options.body);if(!options.headers.authorization?.startsWith('Sidewisp sw_ins_old12345678:')||b.id!==${JSON.stringify(id)}||b.schema!=='sidewisp.authorization-reuse.v1')throw Error('invalid_reuse');writeFileSync(${JSON.stringify(path.join(dir,'reuse.json'))},JSON.stringify({id:b.id,origin:new URL(url).origin,signed:true}));return Response.json(${reuseRejected?"{error:'unsupported'}":`{id:${JSON.stringify(id)},installationId:'sw_ins_old12345678',reusedExistingInstallation:true,status:'completed',expiresAtMs:${expiresAtMs}}`},{status:${reuseRejected?401:200}});}if(new URL(url).pathname==='/v1/device-authorizations/preparation'){if(options.headers.authorization)throw Error('source_credential_leaked');const body=JSON.parse(options.body);reports.push({origin:new URL(url).origin,id:body.id,stage:body.stage,...(body.reasonCode?{reasonCode:body.reasonCode}:{}),proofPresent:/^sw_device_[A-Za-z0-9_-]{43}$/.test(body.deviceSecret)});writeFileSync(${JSON.stringify(path.join(dir,'reports.json'))},JSON.stringify(reports));writeFileSync(${JSON.stringify(path.join(dir,'report.json'))},JSON.stringify({stage:body.stage,reasonCode:body.reasonCode}));return Response.json({});}if(new URL(url).pathname!=='/v1/device-authorizations/begin')throw Error('unexpected_request');const body=JSON.parse(options.body);if(body.id!==${JSON.stringify(id)} || !body.deviceSecret.startsWith('sw_device_'))throw Error('invalid_begin');writeFileSync(${JSON.stringify(ledger)},JSON.stringify({calls:++calls}));return Response.json({id:body.id,userCode:'ABCDEF1234',expiresAtMs:${expiresAtMs}});};`);
  const result=spawnSync(process.execPath,['--import',preload,path.join(root,'scripts/prepare-openclaw.mjs'),...(queueRefused||queued?['--enqueue']:[]),'--archive',archive,'--sha256',sha256,'--endpoint',status.endpoint,'--state-dir',state,...(updateOnly?['--update-only',...(reportTarget?[...(implicitSameOrigin?[]:['--preparation-endpoint',targetEndpoint]),'--request-id',id,'--expires-at-ms',String(expiresAtMs)]:[])]:['--request-id',id,'--expires-at-ms',String(expiresAtMs)]),...(invitationConsent?['--accept-staging-to-production']:[]),...extraArgs],{env:{...process.env,HOME:dir,XDG_CONFIG_HOME:path.join(dir,'config'),PATH:bin+path.delimiter+process.env.PATH,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:config},encoding:'utf8',timeout:20000});
  let persisted;try{persisted=JSON.parse(await readFile(path.join(state,'sidewisp/prepare-status.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let calls=0;try{calls=JSON.parse(await readFile(ledger,'utf8')).calls;}catch(e){if(e.code!=='ENOENT')throw e;}
  let report;try{report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let diagnostics; if(persisted?.failure?.diagnosticId){const {stat}=await import('node:fs/promises');const file=path.join(state,'sidewisp/preparation-diagnostics',persisted.failure.diagnosticId+'.json');diagnostics={body:JSON.parse(await readFile(file,'utf8')),mode:(await stat(file)).mode&0o777};}
  let reports=[];try{reports=JSON.parse(await readFile(path.join(dir,'reports.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const preserved=foreignAuthorization && (await readFile(path.join(state,'sidewisp/device-authorization.json'),'utf8')===oldAuthorization && await readFile(path.join(state,'sidewisp/installation.json'),'utf8')===oldCredential && await readFile(config,'utf8')===configBytes);
  let proofMode;try{const {stat}=await import('node:fs/promises');proofMode=(await stat(path.join(state,'sidewisp/prepare-authorizations',id+'.json'))).mode&0o777;}catch(e){if(e.code!=='ENOENT')throw e;}
  let reply;try{reply=JSON.parse(await readFile(path.join(state,'sidewisp/connection-reply.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(exercise)await exercise({stateDir:state,configFile:config,id,expiresAtMs,sourceEndpoint,targetEndpoint,reply,result});
  return {result,persisted,calls,id,expiresAtMs,report,diagnostics,reports,preserved,proofMode,targetEndpoint,reply};
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
 assert.equal(f.result.status,0,f.result.stderr);const output=JSON.parse(f.result.stdout);assert.equal(output.status,'blocked');assert.equal(output.reason,'existing_endpoint_mismatch');assert.equal(output.nextAction.type,'confirm_endpoint_transition');assert.equal(output.nextAction.expiresAtMs,f.expiresAtMs);assert.equal(output.bindingPreserved,true);assert.equal(output.sourceUpdate,'completed');
 assert.equal(f.calls,0);assert.equal(f.preserved,true);assert.equal(f.proofMode,0o600);
 assert.ok(f.reports.length>=3);assert.equal(f.reports[0].stage,'inspecting');
 assert.deepEqual(f.reports.at(-1),{origin:f.targetEndpoint,id:f.id,stage:'blocked',reasonCode:'existing_endpoint_mismatch',proofPresent:true});
 for(const r of f.reports){assert.equal(r.origin,f.targetEndpoint);assert.equal(r.id,f.id);assert.equal(r.proofPresent,true);}
 assert.equal(f.persisted.status,'blocked');assert.equal(f.persisted.nextAction.type,'confirm_endpoint_transition');
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

test('target reporting requires the original invitation expiry before side effects',async()=>{
 for(const value of ['NaN','0','-1','9007199254740992','']){
  const f=await fixture({updateOnly:true,reportTarget:true,extraArgs:['--expires-at-ms',value]});
  assert.equal(f.result.status,1);assert.match(f.result.stderr,/invalid_prepare_input/);assert.equal(f.calls,0);assert.deepEqual(f.reports,[]);assert.equal(f.persisted,undefined);
 }
 const f=await fixture({updateOnly:true,reportTarget:true,extraArgs:['--expires-at-ms','1']});assert.equal(f.result.status,1);assert.equal(JSON.parse(f.result.stdout).reason,'fresh_invitation_required');assert.equal(f.calls,0);assert.equal(f.report.reasonCode,'fresh_invitation_required');
});

test('explicit staging-production invitation auto-enqueues transition without host question or begin duplication',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,foreignAuthorization:true,invitationConsent:true});
 assert.equal(f.result.status,0,f.result.stderr);const result=JSON.parse(f.result.stdout);
 assert.equal(result.status,'transition_queued');assert.equal(result.nextAction.type,'automatic_transition');
 assert.equal(f.persisted.stage,'connection_pending');assert.equal(f.persisted.status,'connection_pending');assert.equal(f.preserved,true);assert.equal(f.calls,0);
 assert.equal(f.reports.some(r=>r.reasonCode==='existing_endpoint_mismatch'),false);
 assert.doesNotMatch(f.result.stdout,/confirm_endpoint_transition|sw_device_|sw_secret_/);
});
test('narrow invitation flag refuses another endpoint and non-transition path before network',async()=>{
 for(const options of [{updateOnly:true,reportTarget:true,foreignAuthorization:true},{updateOnly:true}]){
  const f=await fixture({...options,extraArgs:['--accept-staging-to-production']});
  assert.equal(f.result.status,1);assert.match(f.result.stderr,/invitation_transition_endpoint_refused/);assert.equal(f.calls,0);assert.deepEqual(f.reports,[]);
 }
});

const replyArgs=['--telegram-target','-100123','--telegram-account','work','--telegram-thread-id','42'];
const expectedRoute={channel:'telegram',target:'-100123',accountId:'work',threadId:'42'};
for(const queued of [false,true])test(`update-only invitation persists current destination intent (${queued?'queued':'direct'})`,async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,foreignAuthorization:true,invitationConsent:true,queued,seedReply:true,extraArgs:replyArgs});
 assert.equal(f.result.status,0,f.result.stderr);
 assert.deepEqual(f.reply,{endpoint:f.targetEndpoint,requestId:f.id,route:expectedRoute});
});
test('ordinary update-only without an invitation does not adopt a route or overwrite an old intent',async()=>{
 const f=await fixture({updateOnly:true,foreignAuthorization:true,seedReply:true,extraArgs:replyArgs});
 assert.equal(f.result.status,0,f.result.stderr);assert.equal(f.reply.requestId,'sw_pair_'+'o'.repeat(32));assert.equal(f.reply.route.target,'999');
});
test('real prepare to activation to uploader ACK sends current reply once; never before accepted health',async()=>{
 await fixture({updateOnly:true,reportTarget:true,foreignAuthorization:true,invitationConsent:true,seedReply:true,extraArgs:replyArgs,exercise:async f=>{
  assert.equal(f.result.status,0,f.result.stderr);
  assert.deepEqual(f.reply,{endpoint:f.targetEndpoint,requestId:f.id,route:expectedRoute});
  const file=path.join(f.stateDir,'sidewisp/connection-reply.json');assert.equal((await stat(file)).mode&0o777,0o600);
  const consent=JSON.parse(await readFile(path.join(f.stateDir,'sidewisp-transitions/invitations',f.id+'.json'),'utf8'));
  const plan=JSON.parse(await readFile(consent.planFile,'utf8'));
  const installationId='sw_ins_new12345678';let approved=false,beginCalls=0,ackCalls=0;
  const fetchImpl=async(u,o)=>{
   if(u.pathname.endsWith('/credential-status'))return Response.json({schema:'sidewisp.credential-status.v1',status:'active',installationId:u.origin===f.sourceEndpoint?plan.sourceInstallationId:installationId});
   assert.equal(u.origin,f.targetEndpoint);const body=JSON.parse(o.body);assert.equal(body.id,f.id);
   if(u.pathname.endsWith('/begin')){beginCalls++;return Response.json({id:f.id,userCode:'ABCDEF1234',expiresAtMs:f.expiresAtMs});}
   assert.equal(u.pathname,'/v1/device-authorizations/poll');
   if(body.acknowledge){ackCalls++;return Response.json({status:'completed'});}
   return Response.json(approved?{status:'approved',credential:{installationId,installationSecret:'sw_secret_'+'n'.repeat(43)}}:{status:'pending'});
  };
  const sent=[],send=createRuntimeTelegramSender({config:{},runtime:{channel:{outbound:{loadAdapter:async()=>({sendText:async ctx=>{sent.push(ctx);return{messageId:'final-6064'};}})}}}});
  const noticeOptions={stateDir:f.stateDir,endpoint:f.targetEndpoint,send};let notifier=createConnectionNotifier(noticeOptions);
  assert.equal((await beginEndpointTransition({plan,confirmation:plan.confirmation,requestId:f.id,expiresAtMs:f.expiresAtMs,fetchImpl})).status,'pending');
  assert.equal((await pollEndpointTransition({plan,fetchImpl})).status,'pending');approved=true;
  assert.equal((await pollEndpointTransition({plan,fetchImpl})).status,'credential_saved');assert.equal(beginCalls,1);assert.equal(ackCalls,1);assert.equal(sent.length,0);
  let starts=0;const activation={plan,confirmation:plan.confirmation,fetchImpl,host:{validate:async()=>{},suspend:async()=>'lease',stop:async()=>{},start:async()=>{starts++;}}};
  assert.equal((await activateEndpointTransition(activation)).status,'activated');
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')),f.reply);
  assert.deepEqual(JSON.parse(await readFile(path.join(path.dirname(plan.candidateStateDir),'source-sidewisp/connection-reply.json'),'utf8')),f.reply);
  await activateEndpointTransition(activation);assert.equal(starts,1);assert.equal(sent.length,0);
  const completion=JSON.parse(await readFile(path.join(f.stateDir,'sidewisp/authorization-completed.json'),'utf8'));
  const now=Math.max(Date.now(),completion.completedAtMs)+1000;notifier=createConnectionNotifier({...noticeOptions,now:()=>now});
  const event=(eventId,type='health.snapshot',occurredAt=new Date(now).toISOString())=>({eventId,type,installationId,occurredAt});
  let rows=[],acknowledge=false,responseStatus=200;
  const spool={pending:n=>rows.slice(0,n).map(event=>({eventId:event.eventId,event})),acknowledge:ids=>{rows=rows.filter(e=>!ids.includes(e.eventId));},deadLetter:id=>{rows=rows.filter(e=>e.eventId!==id);}};
  // Use the actual uploader's server-ACK filter, not a direct success callback.
  const uploader=createUploader({spool,endpoint:f.targetEndpoint,credentialProvider:{current:()=>createFileCredentialStore({stateDir:f.stateDir}).read()},now:()=>now,onAcknowledged:events=>notifier.acknowledged(events),fetchImpl:async()=>Response.json({acknowledgedEventIds:acknowledge?rows.map(e=>e.eventId):[]},{status:responseStatus})});
  const flush=async()=>{await uploader.sendOnce();await notifier.stop();};
  rows=[event('usage','turn.completed')];acknowledge=true;await flush();assert.equal(sent.length,0);
  rows=[event('old','health.snapshot',new Date(completion.completedAtMs-1).toISOString())];await flush();assert.equal(sent.length,0);
  rows=[event('health')];responseStatus=403;await flush();assert.equal(sent.length,0);
  responseStatus=200;acknowledge=false;await flush();assert.equal(sent.length,0);
  acknowledge=true;await flush();assert.equal(sent.length,1);
  assert.deepEqual(sent[0],{cfg:{},to:'-100123',text:'Агент подключён к Sidewisp',accountId:'work',threadId:'42'});
  const receipt=JSON.parse(await readFile(path.join(f.stateDir,'sidewisp',`connection-receipt-${f.id}.json`),'utf8'));assert.deepEqual(receipt,{requestId:f.id,installationId,messageId:'final-6064'});
  await Promise.all(Array.from({length:20},()=>notifier.acknowledged([event('repeat')])));await notifier.stop();
  notifier=createConnectionNotifier({...noticeOptions,now:()=>now});rows=[event('restart')];await flush();assert.equal(sent.length,1);
 }});
});

test('same-production invitation completes correlation for new request, never begin/re-registration',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,sameProduction:true,foreignAuthorization:true,seedReply:true,extraArgs:replyArgs});
 assert.equal(f.result.status,0,f.result.stderr);const r=JSON.parse(f.result.stdout);
 assert.equal(r.status,'connection_pending');assert.equal(r.requestId,f.id);assert.equal(r.installationId,'sw_ins_old12345678');assert.equal(r.reusedExistingInstallation,true);assert.equal(r.bindingPreserved,true);
 assert.equal(f.calls,0);assert.equal(f.preserved,true);assert.equal(f.reply.requestId,f.id);assert.equal(f.reply.endpoint,f.targetEndpoint);assert.deepEqual(f.reply.route,expectedRoute);
 assert.equal(f.persisted.stage,'connection_pending');assert.ok(f.reports.length>=3);for(const p of f.reports){assert.equal(p.id,f.id);assert.equal(p.origin,f.targetEndpoint);}
 assert.doesNotMatch(f.result.stdout+f.result.stderr,/sw_device_|sw_secret_/);
});
test('same-production missing/old backend is blocked, never a false local completed',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,sameProduction:true,foreignAuthorization:true,reuseRejected:true,extraArgs:replyArgs});
 assert.equal(f.result.status,1);assert.equal(JSON.parse(f.result.stdout).reason,'existing_authorization_reuse_failed');assert.equal(f.calls,0);assert.equal(f.preserved,true);assert.equal(f.persisted.stage,'blocked');
});

test('explicit same-origin update invitation cannot disappear when preparation-endpoint is omitted',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,sameProduction:true,foreignAuthorization:true,implicitSameOrigin:true,extraArgs:replyArgs});
 assert.equal(f.result.status,0,f.result.stderr);const r=JSON.parse(f.result.stdout);
 assert.equal(r.status,'connection_pending');assert.equal(r.requestId,f.id);assert.equal(r.reusedExistingInstallation,true);assert.equal(f.calls,0);assert.equal(f.preserved,true);assert.equal(f.reply.requestId,f.id);
});
test('implicit same-origin update invitation still requires original expiry before side effects',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,sameProduction:true,implicitSameOrigin:true,extraArgs:['--expires-at-ms','NaN']});
 assert.equal(f.result.status,1);assert.match(f.result.stderr,/invalid_prepare_input/);assert.deepEqual(f.reports,[]);assert.equal(f.persisted,undefined);
});

test('same-origin update with protocol-rejected credential enters normal begin, preserving installation/config',async()=>{
 const f=await fixture({updateOnly:true,reportTarget:true,sameProduction:true,foreignAuthorization:true,credentialStatus:'rejected',extraArgs:replyArgs,exercise:async f=>{
  assert.equal(JSON.parse(await readFile(path.join(f.stateDir,'sidewisp/installation.json'),'utf8')).installationId,'sw_ins_old12345678');
  assert.deepEqual(JSON.parse(await readFile(f.configFile,'utf8')),{plugins:{entries:{sidewisp:{config:{endpoint:f.sourceEndpoint}}}}});
  assert.equal(JSON.parse(await readFile(path.join(f.stateDir,'sidewisp/device-authorization.json'),'utf8')).id,f.id);
 }});
 assert.equal(f.result.status,0,f.result.stderr);assert.equal(f.calls,1);
 assert.deepEqual(JSON.parse(f.result.stdout),{status:'approval_pending',requestId:f.id,expiresAtMs:f.expiresAtMs,bindingPreserved:true});
 assert.equal(f.persisted.stage,'approval_pending');assert.equal(f.reply.requestId,f.id);
 assert.doesNotMatch(f.result.stdout+f.result.stderr,/sw_device_|sw_secret_/);
});
