#!/usr/bin/env node
// Private code copy OUTSIDE the replaceable plugin and Gateway service.
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
let child=null,running=null,dirty=false,stopping=false,pendingDirective=null,stream=null,streamCredential=null,lastReport=null;
const lifetime=new AbortController();
const credentialKey=c=>c?.status==='active'?`${c.installationId}\0${c.secret}`:null;
function unavailable(error){const old=read(managerFile)??{};save(managerFile,{...old,controlStatus:'unavailable',errorCode:/^[A-Z_]+$/.test(error.message)?error.message:'MANAGER_CHECK_FAILED',checkedAt:new Date().toISOString()});}
async function tick(){
 lastReport=null;
 const credential=await store.read();if(credential?.status!=='active'){pendingDirective=null;return;}
 let current=null;
 try{const r=await exec('openclaw',['gateway','call','sidewisp.status','--params','{}','--json'],{timeout:20000,maxBuffer:1024*1024});current=JSON.parse(r.stdout);
 if(current.endpoint!==config.endpoint||current.installation?.installationId!==credential.installationId)throw Error('BINDING_MISMATCH');
 if(current.enabled&&current.running&&current.connectionReadiness?.ready)save(path.join(directory,'manager-baseline.json'),{version:current.version,endpoint:current.endpoint,installationId:credential.installationId});
 }catch(e){if(e.message==='BINDING_MISMATCH')throw e;}
 const attempt=read(stateFile),previous=read(managerFile);
 const report={managerVersion:version,currentVersion:current?.enabled&&current?.running&&current?.connectionReadiness?.ready?current.version:null,status:attempt?.status??(current?'idle':'unavailable'),targetVersion:attempt?.targetVersion??null,revision:attempt?.revision??previous?.revision??null,reasonCode:attempt?.reasonCode??attempt?.errorCode??null};
 lastReport=report;
 // This heartbeat reports liveness/results only. Never apply its update field.
 await updateHeartbeat({endpoint:config.endpoint,credential,report});
 save(managerFile,{...report,mode:'event_driven',controlStatus:'connected',checkedAt:new Date().toISOString(),requiredVersion:pendingDirective?.targetVersion??null});
 const directive=pendingDirective;
 if(stopping||credentialKey(credential)!==streamCredential||!directive||!shouldApply({directive,currentVersion:current?.version,attempt,active:!!child}))return;
 if(existsSync(stateFile+'.lock'))return; // Interrupted mutation needs inspection.
 save(stateFile,{status:'scheduled',targetVersion:directive.targetVersion,revision:directive.revision,updatedAt:new Date().toISOString()});
 if(credentialKey(await store.read())!==streamCredential)return;
 const payload={...directive,stateFile,baselineFile:path.join(directory,'manager-baseline.json')};
 child=spawn(process.execPath,[fileURLToPath(new URL('./openclaw-update-helper.mjs',import.meta.url)),JSON.stringify(payload)],{stdio:'ignore',env:process.env});
 let finished=false;
 const finish=()=>{if(finished)return;finished=true;child=null;const last=read(stateFile);if(last?.status==='scheduled')save(stateFile,{...last,status:'failed',errorCode:'HELPER_EXITED',updatedAt:new Date().toISOString()});if(stopping)process.exit(0);else if(last?.status!=='deferred')void run();};child.once('exit',finish);child.once('error',finish);
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
process.on('SIGTERM',()=>{stopping=true;lifetime.abort();stream?.abort();clearInterval(timer);watcher.close();if(!child)process.exit(0);});
await maintainUpdateEvents({signal:lifetime.signal,onError:unavailable,connect:async connected=>{
 const credential=await store.read();if(credential?.status!=='active')throw Error('CREDENTIAL_UNAVAILABLE');
 streamCredential=credentialKey(credential);stream=new AbortController();
 const abort=()=>stream.abort();lifetime.signal.addEventListener('abort',abort,{once:true});
 try{await run();if(!lastReport)throw Error('MANAGER_CHECK_FAILED');
 await consumeUpdateEvents({endpoint:config.endpoint,credential,report:lastReport,signal:stream.signal,onDirective:async directive=>{connected();pendingDirective=directive;await run();}});
 }finally{lifetime.signal.removeEventListener('abort',abort);streamCredential=null;pendingDirective=null;}
}});
