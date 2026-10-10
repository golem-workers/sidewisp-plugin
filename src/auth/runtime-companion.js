import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,realpathSync,mkdirSync,renameSync,statSync,lstatSync,chmodSync,chownSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isHostIdle} from '../update/hot-update.js';
const archive=fileURLToPath(new URL('../../runtime/openclaw-2026.9.8-reply-observer.4.tgz',import.meta.url));
const RUNTIME_ARCHIVE_SHA256='712eddf4c19498e1bfa58c488d936bd7d22fb37febe2d011a440bc8f057d0cae';
const hash=x=>createHash('sha256').update(x).digest('hex');
const manifest=JSON.parse(readFileSync(new URL('../../runtime/manifest.json',import.meta.url),'utf8'));
export const runtimeCompanionVersion=manifest.version;
const samePath=(a,b)=>{try{return path.isAbsolute(a)&&path.isAbsolute(b)&&realpathSync(a)===realpathSync(b);}catch{return false;}};
export function resolveManagedRuntime({serviceStatus,stateDir,configPath}) {
 const service=serviceStatus?.service,env=service?.command?.environment;
 if(service?.loaded!==true||service.runtime?.status!=='running'||!Number.isSafeInteger(service.runtime.pid)||service.runtime.pid<=0
  ||service.targetRole==='diagnostic-only'||serviceStatus.config?.mismatch===true
  ||!samePath(serviceStatus.config?.daemon?.path,configPath)
  ||(env?.OPENCLAW_CONFIG_PATH&&!samePath(env.OPENCLAW_CONFIG_PATH,configPath))
  ||!samePath(env?.OPENCLAW_STATE_DIR??path.dirname(serviceStatus.config.daemon.path),stateDir))throw Error('managed_active_profile_required');
 const args=service.command.programArguments;
 if(!Array.isArray(args)||typeof args[1]!=='string'||!path.isAbsolute(args[1]))throw Error('runtime_path_unavailable');
 let root=path.dirname(realpathSync(args[1]));
 for(let n=0;n<3;n++,root=path.dirname(root)){
  let pkg;try{pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));}catch{continue;}
  if(pkg.name==='openclaw'){
   if(pkg.version!=='2026.9.8')throw Error('unsupported_runtime_companion');
   return root;
  }
 }
 throw Error('runtime_path_unavailable');
}
export function stageRuntimeCompanion({runtime,stateDir,archivePath=archive,descriptor=manifest}) {
 if(!path.isAbsolute(runtime)||!path.isAbsolute(stateDir)||JSON.parse(readFileSync(path.join(runtime,'package.json'),'utf8')).version!=='2026.9.8')throw Error('unsupported_runtime_companion');
 const journalDir=path.join(stateDir,'sidewisp','runtime-companion-3989');mkdirSync(journalDir,{recursive:true,mode:0o700});
 const journal=path.join(journalDir,'result.json');const inputs=[];
 for(const file of descriptor.files){
  if(!['dist/dispatch-from-config.finalize-BttBCKPU.mjs','dist/delivery.runtime-D3Jl_drC.mjs','dist/package-update-activation-recovery.mjs'].includes(file.path))throw Error('runtime_manifest_invalid');
  const destination=path.join(runtime,file.path);const meta=statSync(destination);const current=readFileSync(destination);const digest=hash(current);const stock=descriptor.stockFiles.find(f=>f.path===file.path)?.beforeSha256;
  if(![file.beforeSha256,file.afterSha256,stock].includes(digest))throw Error('runtime_source_hash_mismatch');
  inputs.push({file,destination,meta,current,digest});
 }
 if(inputs.length!==3)throw Error('runtime_manifest_invalid');
 if(inputs.every(x=>x.digest===x.file.afterSha256))return {changed:false,version:descriptor.version,hashes:Object.fromEntries(inputs.map(x=>[x.file.path,x.digest]))};
 const bytes=readFileSync(archivePath);if(hash(bytes)!==RUNTIME_ARCHIVE_SHA256)throw Error('runtime_archive_hash_mismatch');
 const outputs=inputs.map(x=>({ ...x,output:execFileSync('tar',['-xOf',archivePath,'runtime-hotfix/'+x.file.path],{maxBuffer:100*1024*1024}) }));
 if(outputs.some(x=>hash(x.output)!==x.file.afterSha256))throw Error('runtime_output_hash_mismatch');
 const save=value=>{const temporary=journal+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600});renameSync(temporary,journal);};
 save({phase:'preparing',version:descriptor.version,beforeHashes:Object.fromEntries(inputs.map(x=>[x.file.path,x.digest]))});
 const changed=[];
 try{
  for(const x of outputs){
   if(hash(readFileSync(x.destination))!==x.digest)throw Error('runtime_changed_before_stage');
   if(x.digest===x.file.afterSha256)continue;
   const backup=path.join(journalDir,path.basename(x.destination)+'.'+x.digest+'.before');try{writeFileSync(backup,x.current,{mode:0o600,flag:'wx'});}catch(error){const meta=lstatSync(backup);if(error.code!=='EEXIST'||!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.uid!==process.getuid()||hash(readFileSync(backup))!==x.digest)throw Error('runtime_backup_mismatch');}
   const temporary=x.destination+'.'+randomUUID()+'.next';writeFileSync(temporary,x.output,{mode:x.meta.mode&0o777});chownSync(temporary,x.meta.uid,x.meta.gid);chmodSync(temporary,x.meta.mode&0o777);renameSync(temporary,x.destination);changed.push(x);
  }
  const result={changed:changed.length>0,version:descriptor.version,hashes:Object.fromEntries(inputs.map(x=>[x.file.path,hash(readFileSync(x.destination))]))};
  save({phase:'prepared',...result,preparedAtMs:Date.now(),pluginReinstalled:false});return result;
 }catch(error){
  for(const x of changed.reverse())if(hash(readFileSync(x.destination))===x.file.afterSha256){const temporary=x.destination+'.rollback';writeFileSync(temporary,x.current,{mode:x.meta.mode&0o777});chownSync(temporary,x.meta.uid,x.meta.gid);renameSync(temporary,x.destination);}
  save({phase:'failed',version:descriptor.version,reason:/^[a-z_]+$/.test(error.message)?error.message:'runtime_preparation_failed'});throw error;
 }
}
export function prepareRuntimeCompanion({run,stateDir,configPath}) {
 const serviceStatus=JSON.parse(run(['gateway','status','--no-probe','--json']));
 const runtime=resolveManagedRuntime({serviceStatus,stateDir,configPath});
 const lanes=JSON.parse(run(['gateway','call','diagnostics.lanes','--params','{}','--json']));
 if(!isHostIdle(lanes))throw Error('host_activation_busy');
 const result=stageRuntimeCompanion({runtime,stateDir});
 const journal=path.join(stateDir,'sidewisp','runtime-companion-3989','result.json');let previous={};try{previous=JSON.parse(readFileSync(journal,'utf8'));}catch{}
 const prepared={...result,gatewayPid:serviceStatus.service.runtime.pid,activationRequired:result.changed||previous.phase!=='completed'};
 if(prepared.activationRequired){writeFileSync(journal+'.activation.tmp',JSON.stringify({...previous,phase:'prepared',...prepared})+'\n',{mode:0o600});renameSync(journal+'.activation.tmp',journal);}
 return prepared;
}

export function finalizeRuntimeCompanion({stateDir,prepared}) {
 const journal=path.join(stateDir,'sidewisp','runtime-companion-3989','result.json');let previous={};try{previous=JSON.parse(readFileSync(journal,'utf8'));}catch{}
 writeFileSync(journal+'.complete.tmp',JSON.stringify({...previous,...prepared,phase:'completed',completedAtMs:Date.now()})+'\n',{mode:0o600});renameSync(journal+'.complete.tmp',journal);
}
