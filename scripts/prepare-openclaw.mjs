#!/usr/bin/env node
import {invitationTransitionConsent,bindInvitationTransitionPlan} from '../src/auth/invitation-transition.js';
import {preparationContinuation,notifyPreparationContinuation} from '../src/auth/preparation-continuation.js';
import {recordPreparationFailure} from '../src/auth/preparation-diagnostics.js';
import {saveConnectionReply,sendConnectionDelay} from '../src/auth/connection-notice.js';
import {queuePreparation} from './queue-preparation.mjs';
import {prepareRuntimeCompanion,finalizeRuntimeCompanion} from '../src/auth/runtime-companion.js';
// Run from an extracted, SHA-256-verified release. Public invitation only;
// credentials and approval proof never appear in arguments, logs or output.
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {installUpdateManager} from './install-update-manager.mjs';
import {isRetainedWork} from '../src/update/hot-update.js';
import {coldActivateOpenClaw} from './cold-activate-openclaw.mjs';
import {prepareConnection} from '../src/auth/prepare-connection.js';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
const args=process.argv.slice(2);const options={};
for(let i=0;i<args.length;i++){if(args[i]==='--accept-staging-to-production')options.invitationConsent=true;else if(args[i]==='--supervised')options.supervised=true;else if(args[i]==='--preparation-lock')options.locked=true;else if(args[i]==='--enqueue')options.enqueue=true;else if(args[i]==='--update-only')options.updateOnly=true;else if(/^--(archive|sha256|endpoint|preparation-endpoint|request-id|state-dir|expires-at-ms|telegram-target|telegram-account|telegram-thread-id)$/.test(args[i]))options[args[i].slice(2)]=args[++i];else throw new Error('invalid_prepare_argument');}
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const stateDir=options['state-dir'];const endpoint=new URL(options.endpoint);
// Maintenance uses the current endpoint. An optional, public target invitation
// gets progress only; it never authorizes a rebind or receives source credentials.
const preparationEndpoint=new URL(options['preparation-endpoint']??options.endpoint);
const requestId=options['request-id'];
// An explicit invitation is never ordinary maintenance, even on the same origin.
const reportsInvitation='preparation-endpoint' in options || options.updateOnly && requestId!==undefined;
const expiresAtMs=options['expires-at-ms']===undefined?undefined:Number(options['expires-at-ms']);
const targetTransition=reportsInvitation && preparationEndpoint.origin!==endpoint.origin;
if(!path.isAbsolute(stateDir??'') || !path.isAbsolute(options.archive??'') || !/^[a-f0-9]{64}$/.test(options.sha256??'')
 || endpoint.protocol!=='https:' || endpoint.origin!==options.endpoint
 || preparationEndpoint.protocol!=='https:' || preparationEndpoint.origin!==(options['preparation-endpoint']??options.endpoint)
 || ('preparation-endpoint' in options && (!options['preparation-endpoint'] || !options.updateOnly || !requestId))
 || (reportsInvitation && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs<=0))
 || ((!options.updateOnly || requestId!==undefined) && !/^sw_pair_[A-Za-z0-9_-]{32}$/.test(requestId??'')))throw new Error('invalid_prepare_input');
if(createHash('sha256').update(readFileSync(options.archive)).digest('hex')!==options.sha256)throw new Error('archive_hash_mismatch');
if(path.resolve(process.env.OPENCLAW_STATE_DIR??'')!==stateDir || !path.isAbsolute(process.env.OPENCLAW_CONFIG_PATH??''))throw new Error('explicit_active_profile_required');
if(options.invitationConsent && (!targetTransition || !options.updateOnly))throw Error('invitation_transition_endpoint_refused');
const consent=options.invitationConsent?await invitationTransitionConsent({stateDir,configFile:process.env.OPENCLAW_CONFIG_PATH,sourceEndpoint:options.endpoint,targetEndpoint:options['preparation-endpoint'],requestId,expiresAtMs}):null;
if(consent?.result){console.log(JSON.stringify(consent.result));process.exit(0);}
const stateFile=path.join(stateDir,'sidewisp','prepare-status.json');mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o700});
const writeState=s=>{writeFileSync(stateFile+'.tmp',JSON.stringify({...s,targetVersion:version,updatedAt:new Date().toISOString()}),{mode:0o600});renameSync(stateFile+'.tmp',stateFile);};
const run=args=>execFileSync('openclaw',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
const jobFile=path.join(stateDir,'sidewisp','prepare-job.json');
const saveTerminal=(status,result)=>{if(options.supervised){const j=JSON.parse(readFileSync(jobFile,'utf8'));writeFileSync(jobFile+'.tmp',JSON.stringify({...j,terminal:status,...(result?{result}:{})}),{mode:0o600});renameSync(jobFile+'.tmp',jobFile);}};
  const client=createDeviceAuthorizationClient({endpoint:endpoint.origin,stateDir});
  const progressClient=preparationEndpoint.origin===endpoint.origin?client:createDeviceAuthorizationClient({endpoint:preparationEndpoint.origin,stateDir});
  let reported='',reportedAt=0,lastStep='queueing';
  const diagnose=e=>{try{return recordPreparationFailure({stateDir,step:lastStep,error:e});}catch{return {step:lastStep,code:'DIAGNOSTICS_UNAVAILABLE'};}};
  let continuation;
  const persist=async s=>{
   if(s.stage==='completed' && targetTransition){
    continuation=await preparationContinuation({stateDir,configFile:process.env.OPENCLAW_CONFIG_PATH,sourceEndpoint:endpoint.origin,targetEndpoint:preparationEndpoint.origin,requestId,expiresAtMs,invitationConsent:!!consent});
    if(consent && continuation.nextAction.type==='confirm_endpoint_transition'){
     const action=continuation.nextAction;const plan=JSON.parse(readFileSync(action.planFile,'utf8'));
     await bindInvitationTransitionPlan({consent,planFile:action.planFile,plan});
     const queued=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('./endpoint-transition.mjs',import.meta.url)),'connect',action.planFile,action.confirmation,requestId,'--expires-at-ms',String(expiresAtMs),'--invitation-consent',consent.file,'--enqueue'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
     continuation={...queued,bindingPreserved:true,nextAction:{type:'automatic_transition',requestId,expiresAtMs}};
     s={...continuation,status:'connection_pending',stage:'connection_pending'};
    }else {
    if(options['telegram-target']){try{await notifyPreparationContinuation({stateDir,requestId,action:continuation.nextAction,route:{channel:'telegram',to:options['telegram-target'],accountId:options['telegram-account'],threadId:options['telegram-thread-id']}});continuation.confirmationDelivery='sent';}catch{continuation.confirmationDelivery='unavailable';}}
    s={...continuation,stage:'blocked',reasonCode:continuation.reason};
    }
   }else if(s.stage==='completed' && reportsInvitation){
    // Same-origin maintenance is not completion of the new invitation.
    // Keep existing credentials and correlate using signed installation + current proof.
    continuation=await progressClient.reuseExisting({id:requestId,runtime:'openclaw',expiresAtMs});
    s={...continuation,stage:'connection_pending'};
   }else if(reportsInvitation && expiresAtMs<=Date.now()){
    s={...s,stage:'blocked',reason:'fresh_invitation_required',reasonCode:'fresh_invitation_required'};
   }
   if(s.stage!=='blocked')lastStep=s.stage;
   writeState({status:s.stage,...s});
   const delayReason=s.reasonCode??s.reason;
   if(s.stage==='blocked'&&delayReason)await sendConnectionDelay({stateDir,endpoint:endpoint.origin,requestId:options['request-id'],reason:delayReason}).catch(()=>{});
   if(!requestId || ['connection_pending','approval_pending'].includes(s.stage))return;
   const progress=s;
   if(progress.stage==='completed')return;
   const key=progress.stage+':'+(progress.reasonCode??progress.reason??'');
   if(key===reported&&Date.now()-reportedAt<30000)return;
   reported=key;reportedAt=Date.now();
   const allowed=['ACTIVE_WORK','HOST_RETAINED_WORK','IDLE_WINDOW_TIMEOUT','host_idle_timeout','fresh_invitation_required','update_failed','collector_not_ready','existing_endpoint_mismatch','transition_activation_failed','preparation_failed'];
   const reason=progress.reasonCode??progress.reason;
   try{await progressClient.reportPreparation({id:requestId,stage:progress.stage,...(reason?{reasonCode:allowed.includes(reason)?reason:'preparation_failed'}:{})});}
   catch{writeState({status:s.stage,...s,progressReporting:'unavailable'});}
  };

if(!options.locked){
 const lock=stateFile+(options.enqueue?'.queue-lock':'.kernel-lock');
 const child=spawn('/usr/bin/flock',['--nonblock','--conflict-exit-code','3',lock,process.execPath,...process.execArgv,fileURLToPath(import.meta.url),...args,'--preparation-lock'],{stdio:'inherit'});
 child.once('error',()=>process.exit(3));child.once('exit',code=>process.exit(code??1));
}else if(options.enqueue){
 let result;
 try{
  result=queuePreparation({stateDir,version,sha256:options.sha256,endpoint:endpoint.origin,args:args.filter(a=>!['--enqueue','--preparation-lock'].includes(a)),script:fileURLToPath(import.meta.url)});
 }catch(e){
  const failure=diagnose(e);
  const reason=/^[a-z_]+$/i.test(e.message)?e.message:'preparation_failed';
  // A competing invitation must not overwrite a live job's state or local proof.
  if(reason!=='another_preparation_pending')await persist({stage:'blocked',reason,failure});
  console.log(JSON.stringify({status:'blocked',reason}));process.exitCode=1;
 }
 if(result){
  if(result.status==='blocked'){await persist({stage:'blocked',reason:result.reason});process.exitCode=1;}
  // A destination invitation still needs its own reply intent during source-only maintenance.
  if(options['telegram-target']&&(!options.updateOnly||reportsInvitation))await saveConnectionReply({stateDir,endpoint:preparationEndpoint.origin,requestId,route:{channel:'telegram',to:options['telegram-target'],accountId:options['telegram-account'],threadId:options['telegram-thread-id']}});
  console.log(JSON.stringify({...result,...(result.status==='preparation_queued'?{nextAction:options.invitationConsent?'Reply exactly «Подключаюсь к Sidewisp» once as the final handoff acknowledgement. End this setup turn: the independent helper automatically completes this invitation-authorized staging-to-production transition. Do not ask another host-confirmation question, repeat setup or begin, or extend the original expiry. Account authorization and first accepted signal remain required.':'Reply exactly «Подключаюсь к Sidewisp» as the final handoff acknowledgement, once; not an empty final. Independent preparation continues; do not repeat setup or begin. Observe sidewisp/prepare-status.json: on confirm_endpoint_transition show source/target and request explicit host confirmation; only then run scripts/endpoint-transition.mjs connect <planFile> <confirmation> <requestId> --expires-at-ms <original-expiry> --enqueue under the same profile. Never use the plan hash as consent.'}:{})}));
 }
}else{
 try{
  const job=options.supervised?JSON.parse(readFileSync(jobFile,'utf8')):null;
  if(job?.terminal){if(job.result)console.log(JSON.stringify(job.result));process.exit(0);}
  // A destination invitation still needs its own reply intent during source-only maintenance.
  if(options['telegram-target']&&(!options.updateOnly||reportsInvitation))await saveConnectionReply({stateDir,endpoint:preparationEndpoint.origin,requestId,route:{channel:'telegram',to:options['telegram-target'],accountId:options['telegram-account'],threadId:options['telegram-thread-id']}});
  const status=()=>{try{return JSON.parse(run(['gateway','call','sidewisp.status','--params','{}','--json']));}catch(e){if(/unknown method[: ]+sidewisp\.status/i.test(String(e.stderr)+' '+String(e.stdout)))return null;throw e;}};
  if(reportsInvitation && expiresAtMs<=Date.now() && !options.supervised)throw Error('fresh_invitation_required');
  let result=await prepareConnection({targetVersion:version,endpoint:endpoint.origin,updateOnly:options.updateOnly,
   resumePreparation:options.supervised, idleDeadlineMs:job?.deadlineMs,
   expiresAtMs:options['expires-at-ms'] === undefined ? undefined : Number(options['expires-at-ms']),
   inspect:status,prepareRuntime:()=>prepareRuntimeCompanion({run,stateDir,configPath:process.env.OPENCLAW_CONFIG_PATH}),finalizeRuntime:prepared=>finalizeRuntimeCompanion({stateDir,prepared}),runtimeNeedsActivation:prepared=>JSON.parse(run(['gateway','status','--no-probe','--json'])).service.runtime.pid===prepared.gatewayPid,persist,
   // Do not wait for collector readiness before configuring a fresh install.
   // Host retained-work refusal stops this attempt; it never permits bypass.
   install:async()=>run(['plugins','install',options.archive,'--force','--accept-capabilities']),
   activate:async()=>{
    run(['config','set','plugins.entries.sidewisp.config.endpoint',endpoint.origin]);
    run(['plugins','reload','sidewisp','--accept-capabilities','--json']);
   },
   coldActivate:()=>coldActivateOpenClaw({run,stateDir,configPath:process.env.OPENCLAW_CONFIG_PATH}),
   upgrade:async()=>{
    await runHelper(s=>persist({stage:'waiting_for_host_idle',reasonCode:s.reasonCode??'ACTIVE_WORK'}));
    const state=JSON.parse(readFileSync(path.join(stateDir,'sidewisp/update-status.json'),'utf8'));
    if(state.status==='deferred')throw Object.assign(new Error('update_deferred'),{reasonCode:state.reasonCode});
    if(state.status==='failed')throw new Error('update_failed');
    if(!['completed','skipped'].includes(state.status))throw new Error('update_not_applied');
   },
   ensureManager:async()=>installUpdateManager({stateDir,endpoint:endpoint.origin,upgrade:true}),
   begin:async()=>{
    return client.begin({id:options['request-id'],runtime:'openclaw'});
   },
  });
  if(continuation)result=continuation;
  saveTerminal(result.status==='blocked'?result.reason:result.status,result);console.log(JSON.stringify(result));
 }catch(e){const failure=diagnose(e);const result={status:'blocked',reason:isRetainedWork(e)?'host_retained_work':/^[a-z_]+$/i.test(e.message)?e.message:'preparation_failed'};await persist({stage:'blocked',reason:result.reason,failure});saveTerminal(result.reason);console.log(JSON.stringify(result));process.exitCode=1;}
}
async function runHelper(onProgress){
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:version,targetSpec:`git:github.com/golem-workers/sidewisp-plugin@v${version}`,
 sha256:options.sha256,archivePath:options.archive,restartDelaySeconds:30,stateFile:path.join(stateDir,'sidewisp/update-status.json')};
 // Keep the helper outside the Gateway lifetime and project busy admission
 // while it runs. A deferred journal is resumable; a failed one is not retried.
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./openclaw-update-helper.mjs',import.meta.url)),JSON.stringify(d)],{stdio:'ignore'});
  let pending=Promise.resolve();
  const poll=setInterval(()=>{try{const s=JSON.parse(readFileSync(d.stateFile,'utf8'));if(s.targetVersion===version&&s.status==='waiting_for_idle')pending=pending.then(()=>onProgress(s));}catch{}},1000);
  child.once('error',e=>{clearInterval(poll);reject(e);});
  child.once('exit',code=>{clearInterval(poll);pending.then(()=>{if(code===0)return resolve();let state;try{state=JSON.parse(readFileSync(d.stateFile,'utf8'));}catch{}reject(new Error(state?.status==='failed'?'update_failed':'update_interrupted'));},reject);});
 });
}
