#!/usr/bin/env node
// This file and its dependencies run from a private copy OUTSIDE the plugin.
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFileCredentialStore} from '../src/auth/credentials.js';
import {updateHeartbeat,shouldApply} from '../src/update/manager.js';
const exec=promisify(execFile),configPath=process.argv[2];
if(!path.isAbsolute(configPath??''))throw Error('MANAGER_CONFIG_REQUIRED');
const config=JSON.parse(readFileSync(configPath,'utf8'));
if(config.schema!=='sidewisp.update-manager.v1'||!path.isAbsolute(config.stateDir??''))throw Error('INVALID_MANAGER_CONFIG');
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const store=createFileCredentialStore({stateDir:config.stateDir});
const directory=path.join(config.stateDir,'sidewisp'),stateFile=path.join(directory,'update-status.json'),managerFile=path.join(directory,'manager-status.json');
const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch{return null;}};
const save=(file,value)=>{writeFileSync(file+'.manager.tmp',JSON.stringify(value)+'\n',{mode:0o600});renameSync(file+'.manager.tmp',file);};
let child=null,running=null,stopping=false;
async function tick(){
 const credential=await store.read();if(credential?.status!=='active')return;
 let current=null;
 try{const r=await exec('openclaw',['gateway','call','sidewisp.status','--params','{}','--json'],{timeout:20000,maxBuffer:1024*1024});current=JSON.parse(r.stdout);
 if(current.endpoint!==config.endpoint||current.installation?.installationId!==credential.installationId)throw Error('BINDING_MISMATCH');
 if(current.enabled&&current.running&&current.connectionReadiness?.ready)save(path.join(directory,'manager-baseline.json'),{version:current.version,endpoint:current.endpoint,installationId:credential.installationId});
 }catch(e){if(e.message==='BINDING_MISMATCH')throw e;}
 const attempt=read(stateFile),previous=read(managerFile);
 const report={managerVersion:version,currentVersion:current?.enabled&&current?.running&&current?.connectionReadiness?.ready?current.version:null,status:attempt?.status??(current?'idle':'unavailable'),targetVersion:attempt?.targetVersion??null,revision:attempt?.revision??previous?.revision??null,reasonCode:attempt?.reasonCode??attempt?.errorCode??null};
 const directive=await updateHeartbeat({endpoint:config.endpoint,credential,report});
 save(managerFile,{...report,controlStatus:'connected',checkedAt:new Date().toISOString(),requiredVersion:directive?.targetVersion??null});
 if(!directive||!shouldApply({directive,currentVersion:current?.version,attempt,active:!!child}))return;
 if(existsSync(stateFile+'.lock'))return; // Interrupted helper needs inspection.
 save(stateFile,{status:'scheduled',targetVersion:directive.targetVersion,revision:directive.revision,updatedAt:new Date().toISOString()});
 const payload={...directive,stateFile,baselineFile:path.join(directory,'manager-baseline.json')};
 child=spawn(process.execPath,[fileURLToPath(new URL('./openclaw-update-helper.mjs',import.meta.url)),JSON.stringify(payload)],{stdio:'ignore',env:process.env});
 const finished=()=>{child=null;const last=read(stateFile);if(last?.status==='scheduled')save(stateFile,{...last,status:'failed',errorCode:'HELPER_EXITED',updatedAt:new Date().toISOString()});void run();};child.once('exit',finished);child.once('error',finished);
}
function run(){return running??(running=tick().catch(e=>{const old=read(managerFile)??{};save(managerFile,{...old,controlStatus:'unavailable',errorCode:/^[A-Z_]+$/.test(e.message)?e.message:'MANAGER_CHECK_FAILED',checkedAt:new Date().toISOString()});}).finally(()=>{running=null;}));}
await run();
// One outbound control heartbeat, no GitHub discovery and no model invocation.
const timer=setInterval(()=>{if(!stopping)void run();},60000);
process.on('SIGTERM',()=>{stopping=true;clearInterval(timer);if(!child)process.exit(0);else child.once('exit',()=>process.exit(0));});
