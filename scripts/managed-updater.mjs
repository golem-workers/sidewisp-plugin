#!/usr/bin/env node
// Private code copy OUTSIDE the replaceable plugin and Gateway service.
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {createPendingReleaseStore} from '../src/update/pending-release.js';
import {maintenancePlan} from '../src/update/collector-maintenance.js';
import {fileURLToPath} from 'node:url';
import {workerActive,startUpdateWorker,recoverableDirective} from '../src/update/worker.js';
import {createFileCredentialStore} from '../src/auth/credentials.js';
import {updateHeartbeat,shouldApply} from '../src/update/manager.js';
import {consumeUpdateEvents,maintainUpdateEvents,watchManagerFiles} from '../src/update/event-client.js';
const exec=promisify(execFile),configPath=process.argv[2];
if(!path.isAbsolute(configPath??''))throw Error('MANAGER_CONFIG_REQUIRED');
const config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.schema!=='sidewisp.update-manager.v1'||!path.isAbsolute(config.stateDir??''))throw Error('INVALID_MANAGER_CONFIG');
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const store=createFileCredentialStore({stateDir:config.stateDir});
const directory=path.join(config.stateDir,'sidewisp'),stateFile=path.join(directory,'update-status.json'),managerFile=path.join(directory,'manager-status.json');
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const save=(file,value)=>{writeFileSync(file+'.manager.tmp',JSON.stringify(value)+'\n',{mode:0o600});renameSync(file+'.manager.tmp',file);};
let running=null,dirty=false,stopping=false,pendingDirective=null,stream=null,streamCredential=null,lastReport=null;
const lifetime=new AbortController();
const pendingReleases=createPendingReleaseStore({stateDir:config.stateDir,endpoint:config.endpoint});
const credentialKey=c=>c?.status==='active'?`${c.installationId}\0${c.secret}`:null;
function unavailable(error){const old=read(managerFile)??{};save(managerFile,{...old,controlStatus:'unavailable',errorCode:/^[A-Z_]+$/.test(error.message)?error.message:'MANAGER_CHECK_FAILED',checkedAt:new Date().toISOString()});}
async function tick(){
 lastReport=null;
 const credential=await store.read();if(credential?.status!=='active'){pendingDirective=null;return;}
 pendingDirective=pendingReleases.read(credential);
 let current=null;
 try{const r=await exec('openclaw',['gateway','call','sidewisp.status','--params','{}','--json'],{timeout:20000,maxBuffer:1024*1024});current=JSON.parse(r.stdout);
 if(current.endpoint!==config.endpoint||current.installation?.installationId!==credential.installationId)throw Error('BINDING_MISMATCH');
 if(current.enabled&&current.running&&current.connectionReadiness?.ready)save(path.join(directory,'manager-baseline.json'),{version:current.version,endpoint:current.endpoint,installationId:credential.installationId,stateId:current.connectionReadiness.stateId});
 }catch(e){if(e.message==='BINDING_MISMATCH')throw e;}
 const attempt=read(stateFile),previous=read(managerFile);
 const report={managerVersion:version,currentVersion:current?.enabled&&current?.running&&current?.connectionReadiness?.ready?current.version:null,status:attempt?.status??(current?'idle':'unavailable'),targetVersion:attempt?.targetVersion??null,revision:attempt?.revision??previous?.revision??null,reasonCode:attempt?.reasonCode??attempt?.errorCode??null};
 lastReport=report;
 // This heartbeat reports liveness/results only. Never apply its update field.
 let controlStatus='connected',controlError=null;try {await updateHeartbeat({endpoint:config.endpoint,credential,report});}catch(error){controlStatus='unavailable';controlError=error;unavailable(error);}
 save(managerFile,{...report,mode:'event_driven',controlStatus,checkedAt:new Date().toISOString(),requiredVersion:pendingDirective?.targetVersion??null});
 if(controlError?.message==='CREDENTIAL_REJECTED'){pendingReleases.accept(null,credential);pendingDirective=null;return;}
 const journalPath=path.join(directory,'current-update.json'),journal=read(journalPath);
 if(existsSync(journalPath)&&!journal)throw Error('INVALID_UPDATE_JOURNAL');
 const recovery=recoverableDirective({journal,credential,endpoint:config.endpoint,stateDir:config.stateDir,attempt});
 const recovering=!!recovery;
 if(journal&&!recovery&&!['completed','failed'].includes(journal.status))throw Error('UPDATE_RECOVERY_REVIEW_REQUIRED');
 // Already-authorized intent (including pre-mutation) resumes without SSE.
 // Keep the completed update immutable; a separate profile-scoped worker
 // maintains the installed plugin even with no new server directive.
 const maintenanceFile=path.join(directory,'collector-recovery.json');
 const plan=maintenancePlan({current,attempt,journal,baseline:read(path.join(directory,'manager-baseline.json')),credential,endpoint:config.endpoint,stateId:createHash('sha256').update(realpathSync(config.stateDir)).digest('hex'),state:read(maintenanceFile)??{}});
 if(!stopping&&!await workerActive({stateDir:config.stateDir,run:exec})){
  save(maintenanceFile,plan.state);
  if(plan.due&&!recovery&&(!pendingDirective||!shouldApply({directive:pendingDirective,currentVersion:current?.version,currentReady:!!current?.connectionReadiness?.ready,attempt}))){
   save(maintenanceFile,{...plan.state,nextAttemptAtMs:Date.now()+180000});
   await startUpdateWorker({stateDir:config.stateDir,directive:config,helper:fileURLToPath(new URL('./collector-recovery.mjs',import.meta.url)),run:exec});return;
  }
 }
 const directive=recovery??pendingDirective;
 if(stopping||!directive)return;
 if(await workerActive({stateDir:config.stateDir,run:exec}))return;
 if(!recovering&&!shouldApply({directive,currentVersion:current?.version,currentReady:!!(current?.enabled&&current?.running&&current?.connectionReadiness?.ready),attempt}))return;
 if(existsSync(stateFile+'.lock'))return; // Legacy interrupted transactions require explicit recovery.
 // The helper owns the durable attempt; never erase its crash checkpoint here.
 const latestCredential=await store.read();if(credentialKey(latestCredential)!==credentialKey(credential))return;
 const payload={...directive,stateFile,baselineFile:path.join(directory,'manager-baseline.json')};
 // systemd owns this worker in a separate cgroup, never a child of manager/Gateway.
 await startUpdateWorker({stateDir:config.stateDir,directive:payload,helper:fileURLToPath(new URL('./openclaw-update-helper.mjs',import.meta.url)),run:exec});
}
function run(){dirty=true;if(running)return running;return running=(async()=>{while(dirty&&!stopping){dirty=false;try{await tick();}catch(e){unavailable(e);}}})().finally(()=>{running=null;});}
await run();
// Transport/result heartbeats remain independent of release notification.
const timer=setInterval(()=>{if(!stopping)void run();},60000);
const watcher=watchManagerFiles({directory,
 onCredential:c=>{if(credentialKey(c)!==streamCredential){pendingDirective=null;stream?.abort();}},
 // Do not immediately re-launch a helper that exhausted its idle window.
 onAttempt:attempt=>{if(attempt?.status!=='deferred')void run();},
 onError:error=>{unavailable(error);stream?.abort();},
});
process.on('SIGTERM',()=>{stopping=true;lifetime.abort();stream?.abort();clearInterval(timer);watcher.close();process.exit(0);});
await maintainUpdateEvents({signal:lifetime.signal,onError:unavailable,connect:async connected=>{
 const credential=await store.read();if(credential?.status!=='active')throw Error('CREDENTIAL_UNAVAILABLE');
 streamCredential=credentialKey(credential);stream=new AbortController();
 const abort=()=>stream.abort();lifetime.signal.addEventListener('abort',abort,{once:true});
 try{await run();if(!lastReport)throw Error('MANAGER_CHECK_FAILED');
 await consumeUpdateEvents({endpoint:config.endpoint,credential,report:lastReport,signal:stream.signal,onDirective:async directive=>{
  const latestCredential=await store.read();
  if(credentialKey(latestCredential)!==credentialKey(credential))throw Error('CREDENTIAL_CHANGED');
  pendingReleases.accept(directive,credential);connected();pendingDirective=directive;await run();}});
 }finally{lifetime.signal.removeEventListener('abort',abort);streamCredential=null;}
}});
