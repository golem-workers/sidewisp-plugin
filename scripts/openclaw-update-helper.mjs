#!/usr/bin/env node
import {safeUpdateFailure} from '../src/update/failure.js';
import {coldActivateOpenClaw,startStoppedOpenClaw} from './cold-activate-openclaw.mjs';
import {execFileSync,spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync,openSync,closeSync,fsyncSync,realpathSync,appendFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isNewerVersion,validUpdateDirective} from '../src/update/directive.js';
import {isHostIdle} from '../src/update/hot-update.js';
import {convergeCurrentRelease} from '../src/update/current-release.js';
const locked=process.argv[2]==='--kernel-lock';
const directive=JSON.parse(process.argv[locked?3:2]??'null');
if(!directive?.stateFile||!path.isAbsolute(directive.stateFile)||!validUpdateDirective(directive)||!/^[a-f0-9]{64}$/.test(directive.sha256??''))process.exit(2);
const stateFile=directive.stateFile,directory=path.dirname(stateFile);
mkdirSync(directory,{recursive:true,mode:0o700});
// Kernel-owned lifetime: no stale PID marker can permanently block recovery.
if(!locked) {
 const child=spawn('/usr/bin/flock',['--nonblock','--conflict-exit-code','3',stateFile+'.kernel-lock',process.execPath,...process.execArgv,fileURLToPath(import.meta.url),'--kernel-lock',JSON.stringify(directive)],{stdio:'inherit',env:process.env});
 child.once('error',()=>process.exit(3));child.once('exit',code=>process.exit(code??1));
} else {
 if(!path.isAbsolute(process.env.OPENCLAW_STATE_DIR??'')||realpathSync(directory)!==realpathSync(path.join(process.env.OPENCLAW_STATE_DIR,'sidewisp')))throw Error('EXPLICIT_ACTIVE_PROFILE_REQUIRED');
 const profileId=createHash('sha256').update(realpathSync(process.env.OPENCLAW_STATE_DIR)).digest('hex');
 const journalFile=path.join(directory,'current-update.json');
 const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw Error('INVALID_UPDATE_JOURNAL');}};
 const durable=(file,value)=>{const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,file);const dir=openSync(path.dirname(file),'r');try{fsyncSync(dir);}finally{closeSync(dir);}};
 const previous=read(journalFile);
 let journal=previous?.directive?.targetVersion===directive.targetVersion&&previous.directive.sha256===directive.sha256&&previous.directive.revision===directive.revision?previous:null;
 // Runtime readiness probes must reach the matched local Gateway, not an outbound proxy.
 const localBypass=[process.env.NO_PROXY,process.env.no_proxy,'127.0.0.1,localhost,::1'].filter(Boolean).join(',');
 const cliEnvironment={...process.env,NO_PROXY:localBypass,no_proxy:localBypass};
 const run=args=>{try{return execFileSync('openclaw',args,{env:cliEnvironment,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});}catch(error){
  const log=path.join(directory,'update-private.log');if(existsSync(log)&&readFileSync(log).length>1024*1024)rmSync(log);
  appendFileSync(log,JSON.stringify({at:new Date().toISOString(),command:args.slice(0,2),exitCode:error.status??null,stdout:String(error.stdout??'').slice(-16000),stderr:String(error.stderr??'').slice(-16000)})+'\n',{mode:0o600});throw error;
 }};
 const status=()=>JSON.parse(run(['gateway','call','sidewisp.status','--params','{}','--json']));
 const idle=()=>isHostIdle(JSON.parse(run(['gateway','call','diagnostics.lanes','--params','{}','--json'])));
 const write=state=>{Object.assign(journal,state,{updatedAt:new Date().toISOString()});durable(journalFile,journal);durable(stateFile,{...state,status:['activating','repairing'].includes(state.status)?'updating':state.status,mode:'single_current',targetVersion:directive.targetVersion,revision:directive.revision??null,attemptId:journal.attemptId,installCount:journal.installCount??0,updatedAt:journal.updatedAt});};
 try {
  if(journal?.status==='completed'||journal?.status==='failed')process.exit(0);
  if(!journal) {
   let current;try{current=status();}catch{}
   const baseline=read(path.join(directory,'manager-baseline.json'));
   const credential=read(path.join(directory,'installation.json'));
   const original=current?.endpoint&&current?.installation?.installationId?{version:current.version,endpoint:current.endpoint,installationId:current.installation.installationId,stateId:current.connectionReadiness?.stateId}:baseline;
   if(original?.stateId!==profileId)throw Error('managed_active_profile_required');
   if(!original?.endpoint||!original?.installationId||credential?.status!=='active'||original.installationId!==credential.installationId)throw Error('RECOVERY_BASELINE_REQUIRED');
   if(current&&isNewerVersion(current.version,directive.targetVersion))throw Error('NEWER_PACKAGE_INSTALLED');
   journal={schema:'sidewisp.current-update.v1',directive,attemptId:randomUUID(),baseline:original,mutated:false,staged:false,activated:false,installCount:0};
   write({status:'scheduled',phase:'accepted'});
   await new Promise(r=>setTimeout(r,directive.restartDelaySeconds*1000));
  }
  const credential=read(path.join(directory,'installation.json'));
  if(credential?.status!=='active'||credential.installationId!==journal.baseline.installationId)throw Error('BINDING_CHANGED');
  const archive=path.join(directory,'current-release.tgz');
  let bytes;
  if(existsSync(archive)&&createHash('sha256').update(readFileSync(archive)).digest('hex')===directive.sha256)bytes=readFileSync(archive);
  else if(directive.archivePath) {if(!path.isAbsolute(directive.archivePath))throw Error('INVALID_ARCHIVE_PATH');bytes=readFileSync(directive.archivePath);}
  else {const response=await fetch('https://github.com/golem-workers/sidewisp-plugin/releases/download/v'+directive.targetVersion+'/sidewisp-plugin-'+directive.targetVersion+'.tgz',{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('ARTIFACT_DOWNLOAD_FAILED');bytes=Buffer.from(await response.arrayBuffer());}
  if(bytes.length>50*1024*1024||createHash('sha256').update(bytes).digest('hex')!==directive.sha256)throw Error('ARTIFACT_HASH_MISMATCH');
  writeFileSync(archive,bytes,{mode:0o600});
  // Resolve a committed install after a helper crash without installing it again.
  if(journal.phase==='install_intent') {
   try {const inspected=JSON.parse(run(['plugins','inspect','sidewisp','--runtime','--json']));
    const root=inspected.install?.installPath??inspected.plugin?.rootDir;
    if(path.isAbsolute(root??'')&&JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version===directive.targetVersion)journal.staged=true;
   }catch{}
  }
  const result=await convergeCurrentRelease({targetVersion:directive.targetVersion,journal,status,idle,write,
   recoverStopped:async()=>{if(journal.staged&&!journal.activated){try {if(idle()){await coldActivateOpenClaw({run,stateDir:process.env.OPENCLAW_STATE_DIR,configPath:process.env.OPENCLAW_CONFIG_PATH});return true;}}catch(error){if(error.message==='host_activation_busy')return false;}}return startStoppedOpenClaw({run,stateDir:process.env.OPENCLAW_STATE_DIR,configPath:process.env.OPENCLAW_CONFIG_PATH,
    prepare:()=>{if(!journal.stoppedRepaired){if(journal.installCount>=2)throw Error('CURRENT_RELEASE_UNHEALTHY');journal.installCount++;write({status:'repairing',phase:'install_intent'});run(['plugins','install',archive,'--force','--accept-capabilities']);journal.staged=true;journal.stoppedRepaired=true;write({status:'repairing',phase:'installed'});}}});},
   verify:after=>{const saved=read(path.join(directory,'installation.json'));if(saved?.status!=='active'||after.endpoint!==journal.baseline.endpoint||after.installation?.installationId!==journal.baseline.installationId||saved.installationId!==journal.baseline.installationId)throw Error('BINDING_CHANGED');},
   install:()=>run(['plugins','install',archive,'--force','--accept-capabilities']),
   reload:()=>run(['plugins','reload','sidewisp','--accept-capabilities','--json']),
   activate:()=>coldActivateOpenClaw({run,stateDir:process.env.OPENCLAW_STATE_DIR,configPath:process.env.OPENCLAW_CONFIG_PATH})});
  if(result==='completed')rmSync(archive,{force:true});
 }catch(error){
  journal??={schema:'sidewisp.current-update.v1',directive,attemptId:randomUUID()};
  write({status:'failed',errorCode:safeUpdateFailure(error),phase:journal.phase??'preflight'});process.exitCode=1;
 }
}
