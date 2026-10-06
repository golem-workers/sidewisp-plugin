#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isNewerVersion, validUpdateDirective } from '../src/update/directive.js';
import { applyHotUpdate, isHostIdle } from '../src/update/hot-update.js';

const directive = JSON.parse(process.argv[2] ?? 'null');
if (!directive?.stateFile || !path.isAbsolute(directive.stateFile) || !validUpdateDirective(directive)
  || !/^[a-f0-9]{64}$/.test(directive.sha256 ?? '')) process.exit(2);
const stateFile = directive.stateFile;
mkdirSync(path.dirname(stateFile), {recursive:true, mode:0o700});
const lock = `${stateFile}.lock`;
let lockFd;
try { lockFd = openSync(lock, 'wx', 0o600); } catch { process.exit(3); }
const attemptId = `${Date.now()}-${process.pid}`;
const writeState = state => {
 const temp = `${stateFile}.${process.pid}.tmp`;
 writeFileSync(temp, JSON.stringify({...state,targetVersion:directive.targetVersion,revision:directive.revision??null,attemptId,updatedAt:new Date().toISOString()})+'\n',{mode:0o600});
 renameSync(temp,stateFile);
};
const run = args => execFileSync('openclaw',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
const status = () => {
 try {return JSON.parse(run(['gateway','call','sidewisp.status','--params','{}','--json']));}
 catch(e) {if(directive.baselineFile && /unknown method[: ]+sidewisp\.status/i.test(String(e.stderr)+' '+String(e.stdout)))return null;throw e;}
};
const idle = () => isHostIdle(JSON.parse(run(['gateway','call','diagnostics.lanes','--params','{}','--json'])));
const installed = () => {
 const i=JSON.parse(run(['plugins','inspect','sidewisp','--runtime','--json']));
 const root=[i.path,i.plugin?.path,i.runtime?.path,i.plugin?.rootDir,i.install?.installPath,i.plugin?.source]
 .filter(p=>typeof p==='string'&&existsSync(p)).flatMap(p=>[p,path.dirname(p)])
 .find(p=>existsSync(path.join(p,'package.json')));
 if(!root)throw new Error('INSTALLED_PACKAGE_UNAVAILABLE');
 return {root,version:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version};
};
const recoveryFile = path.join(path.dirname(stateFile), `recovery-${directive.targetVersion}.json`);
let backup=null;
let original=null;
try {
 writeState({status:'scheduled'});
 await new Promise(resolve=>setTimeout(resolve,directive.restartDelaySeconds*1000));
 const serving=status();
 original=serving;
 if(!original && directive.baselineFile===path.join(path.dirname(stateFile),'manager-baseline.json')) {
  const b=JSON.parse(readFileSync(directive.baselineFile,'utf8'));
  const credential=JSON.parse(readFileSync(path.join(path.dirname(stateFile),'installation.json'),'utf8'));
  if(b.installationId!==credential.installationId || credential.status!=='active')throw Error('BINDING_CHANGED');
  original={version:b.version,endpoint:b.endpoint,installation:{installationId:b.installationId}};
 }
 if(!original)throw Error('RECOVERY_BASELINE_REQUIRED');
 if(serving && !isNewerVersion(directive.targetVersion,original.version)) {
  writeState({status:'skipped',reasonCode:'TARGET_NOT_NEWER'});
 } else {
  const current=installed();
  if(existsSync(recoveryFile)) {
   const saved=JSON.parse(readFileSync(recoveryFile, "utf8"));
   const candidate=path.join(path.dirname(stateFile),path.basename(saved.backup??""));
   if(saved.sourceVersion!==original.version || saved.backup!==candidate || !/^rollback-[0-9]+-[0-9]+$/.test(path.basename(candidate)) || !existsSync(path.join(candidate,"package.json")))throw new Error("INVALID_RECOVERY_CHECKPOINT");
   backup=candidate;
  }
  // Never downgrade a separately installed newer release.
  if(isNewerVersion(current.version,directive.targetVersion))throw new Error('NEWER_PACKAGE_INSTALLED');
  const archive=path.join(path.dirname(stateFile),`release-${directive.targetVersion}.tgz`);
  const url=`https://github.com/golem-workers/sidewisp-plugin/releases/download/v${directive.targetVersion}/sidewisp-plugin-${directive.targetVersion}.tgz`;
  let bytes;
  if(directive.archivePath) {
   if(!path.isAbsolute(directive.archivePath))throw new Error('INVALID_ARCHIVE_PATH');
   bytes=readFileSync(directive.archivePath);
  } else {
   const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
   if(!response.ok)throw new Error('ARTIFACT_DOWNLOAD_FAILED');
   bytes=Buffer.from(await response.arrayBuffer());
  }
  if(bytes.length>50*1024*1024 || createHash('sha256').update(bytes).digest('hex')!==directive.sha256)throw new Error('ARTIFACT_HASH_MISMATCH');
  writeFileSync(archive,bytes,{mode:0o600});
  if(current.version!==directive.targetVersion && !backup) {
   backup=path.join(path.dirname(stateFile),`rollback-${attemptId}`);
   cpSync(current.root,backup,{recursive:true,errorOnExist:true});
   writeFileSync(recoveryFile,JSON.stringify({sourceVersion:original.version,backup}),{mode:0o600});
  }
  await applyHotUpdate({targetVersion:directive.targetVersion,status,idle,writeState,alreadyStaged:current.version===directive.targetVersion,
   verify:after=>{if(after.endpoint!==original.endpoint || after.installation?.installationId!==original.installation?.installationId)throw new Error('BINDING_CHANGED');},
   install:()=>run(['plugins','install',archive,'--force','--accept-capabilities']),
   reload:()=>run(['plugins','reload','sidewisp','--accept-capabilities','--json'])});
  const terminal=JSON.parse(readFileSync(stateFile,'utf8'));
  if(terminal.status==='completed') {
   const after=status();
   if(after.endpoint!==original.endpoint || after.installation?.installationId!==original.installation?.installationId)
    throw new Error('BINDING_CHANGED');
   if(backup)rmSync(backup,{recursive:true,force:true});
   rmSync(recoveryFile,{force:true});
   rmSync(archive,{force:true});
  }
 }
} catch(error) {
 // A denied install must never cause a Gateway restart, file overwrite or a
 // second install. Roll back only an actually applied but unhealthy generation.
 let applied=false;
 try {applied=status().version===directive.targetVersion;} catch {}
 if(applied && backup && original) {
  try {
   writeState({status:'rolling_back',errorCode:'TARGET_VERIFICATION_FAILED'});
   await applyHotUpdate({targetVersion:original.version,status,idle,writeState:s=>writeState({...s,status:s.status==='completed'?'rolled_back':s.status}),
    install:()=>run(['plugins','install',backup,'--force','--accept-capabilities']),
    reload:()=>run(['plugins','reload','sidewisp','--accept-capabilities','--json'])});
  } catch {writeState({status:'failed',errorCode:'ROLLBACK_REQUIRES_RECOVERY'});}
 } else writeState({status:'failed',errorCode:/^[A-Z_]+$/.test(error.message)?error.message:'INSTALL_OR_RELOAD_REFUSED'});
 process.exitCode=1;
} finally {closeSync(lockFd);rmSync(lock,{force:true});}
