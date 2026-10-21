import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,realpathSync,mkdirSync,renameSync,statSync,lstatSync,unlinkSync,chmodSync,chownSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isHostIdle} from '../update/hot-update.js';
const archive=fileURLToPath(new URL('../../runtime/openclaw-2026.9.8-reply-observer.5.tgz',import.meta.url));
const RUNTIME_ARCHIVE_SHA256='2aeb8fdde1083e8846b6c3624b56906a55e70335be3d12875195f7beadb7f182';
const hash=x=>createHash('sha256').update(x).digest('hex');
const manifest=JSON.parse(readFileSync(new URL('../../runtime/manifest.json',import.meta.url),'utf8'));
export const runtimeCompanionVersion=manifest.version;
const samePath=(a,b)=>{try{return path.isAbsolute(a)&&path.isAbsolute(b)&&realpathSync(a)===realpathSync(b);}catch{return false;}};
// Parse only the supported Node launcher prefix, never scan option values or
// Gateway arguments for a plausible runtime path. Unknown prefixes fail closed.
function managedEntrypoint(args) {
 if(!Array.isArray(args)||args.some(a=>typeof a!=='string'||a.length===0)||!/^node(?:js)?(?:\.exe)?$/.test(path.basename(args[0]??'')))throw Error('runtime_path_unavailable');
 let i=1;const seen=new Set();
 while(i<args.length&&args[i].startsWith('-')){
  if(args[i]==='--'){i++;break;}
  const m=/^--(max[-_]old[-_]space[-_]size|max[-_]semi[-_]space[-_]size)(?:=(.*))?$/.exec(args[i]);
  if(!m)throw Error('runtime_path_unavailable');
  const key=m[1].replaceAll('_','-'),value=m[2]??args[++i];
  if(seen.has(key)||typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<=0)throw Error('runtime_path_unavailable');
  seen.add(key);i++;
 }
 if(typeof args[i]!=='string'||!path.isAbsolute(args[i]))throw Error('runtime_path_unavailable');
 try{const entry=realpathSync(args[i]);if(!statSync(entry).isFile())throw Error();return entry;}catch{throw Error('runtime_path_unavailable');}
}
export function resolveManagedRuntime({serviceStatus,stateDir,configPath}) {
 const service=serviceStatus?.service,env=service?.command?.environment;
 if(service?.loaded!==true||service.runtime?.status!=='running'||!Number.isSafeInteger(service.runtime.pid)||service.runtime.pid<=0
  ||service.targetRole==='diagnostic-only'||serviceStatus.config?.mismatch===true
  ||!samePath(serviceStatus.config?.daemon?.path,configPath)
  ||(env?.OPENCLAW_CONFIG_PATH&&!samePath(env.OPENCLAW_CONFIG_PATH,configPath))
  ||!samePath(env?.OPENCLAW_STATE_DIR??path.dirname(serviceStatus.config.daemon.path),stateDir))throw Error('managed_active_profile_required');
 let root=path.dirname(managedEntrypoint(service.command.programArguments));
 for(let n=0;n<3;n++,root=path.dirname(root)){
  let pkg;try{pkg=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));}catch{continue;}
  if(pkg.name==='openclaw'){
   return root;
  }
 }
 throw Error('runtime_path_unavailable');
}
// Newer hosts ship the native ownership/delivery APIs. Never transplant a
// 2026.9.8 binary hotfix onto them, and never admit a host by semver alone.
export function inspectNativeRuntime(runtime,pkg=JSON.parse(readFileSync(path.join(runtime,'package.json'),'utf8'))) {
 const dist=path.join(runtime,'dist'),names=readdirSync(dist),hashes={};
 const requireSource=(prefix,markers)=>{
  for(const name of names.filter(n=>n.startsWith(prefix)&&n.endsWith('.mjs'))){
   const source=readFileSync(path.join(dist,name),'utf8');
   if(markers.every(marker=>source.includes(marker))){hashes['dist/'+name]=hash(source);return;}
  }
  throw Error('runtime_capability_missing_'+prefix.replaceAll('-','_'));
 };
 for(const key of ['plugin-entry','agent-runtime','config-mutation']) {
  const exported=pkg.exports?.['./plugin-sdk/'+key];
  const target=typeof exported==='string'?exported:exported?.import??exported?.default;
  if(typeof target!=='string'||!statSync(path.resolve(runtime,target)).isFile())throw Error('runtime_sdk_capability_missing');
 }
 requireSource('services-',['withPluginServiceScheduler','runOutsideOperatorToolGatewayAuthority','retainConsumer','lease']);
 requireSource('hooks-',['reply_dispatch','message_sent','before_dispatch']);
 requireSource('registry-',['registerAgentEventSubscription','registerService','createPluginApi']);
 requireSource('delivery-',['runMessageSent','sessionKeyForInternalHooks']);
 return {changed:false,activationRequired:false,native:true,version:pkg.version,hashes};
}

export function stageRuntimeCompanion({runtime,stateDir,archivePath=archive,descriptor=manifest}) {
 if(!path.isAbsolute(runtime)||!path.isAbsolute(stateDir))throw Error('runtime_path_unavailable');
 const pkg=JSON.parse(readFileSync(path.join(runtime,'package.json'),'utf8'));
 if(pkg.name!=='openclaw')throw Error('runtime_path_unavailable');
 if(pkg.version!=='2026.9.8')return inspectNativeRuntime(runtime,pkg);
 const journalDir=path.join(stateDir,'sidewisp','runtime-companion-4013');mkdirSync(journalDir,{recursive:true,mode:0o700});
 const journal=path.join(journalDir,'result.json');const inputs=[];
 const allowed=['dist/dispatch-from-config.finalize-BttBCKPU.mjs','dist/delivery.runtime-D3Jl_drC.mjs','dist/package-update-activation-recovery.mjs','dist/hook-runner-global-CwCyBBBr.mjs','dist/services-9PyB9Rj_.mjs','dist/service-hook-owners.mjs'];
 if(descriptor.files.length!==allowed.length || new Set(descriptor.files.map(f=>f.path)).size!==allowed.length)throw Error('runtime_manifest_invalid');
 for(const file of descriptor.files){
  if(!allowed.includes(file.path)||!/^[a-f0-9]{64}$/.test(file.afterSha256))throw Error('runtime_manifest_invalid');
  const destination=path.join(runtime,file.path);let meta,current,digest=null;
  try{meta=lstatSync(destination);if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1)throw Error('runtime_source_invalid');current=readFileSync(destination);digest=hash(current);}catch(e){if(e.code!=='ENOENT')throw e;}
  const stock=descriptor.stockFiles.find(f=>f.path===file.path)?.beforeSha256;
  const accepted=[file.beforeSha256,file.afterSha256,...(file.supportedBeforeSha256??[]),stock].filter(x=>x!==undefined);
  if(!accepted.includes(digest))throw Error('runtime_source_hash_mismatch');
  if(digest===null&&file.path!=='dist/service-hook-owners.mjs')throw Error('runtime_source_hash_mismatch');
  inputs.push({file,destination,meta,current,digest});
 }
 if(inputs.every(x=>x.digest===x.file.afterSha256))return {changed:false,version:descriptor.version,hashes:Object.fromEntries(inputs.map(x=>[x.file.path,x.digest]))};
 const bytes=readFileSync(archivePath);if(hash(bytes)!==RUNTIME_ARCHIVE_SHA256)throw Error('runtime_archive_hash_mismatch');
 const outputs=inputs.map(x=>({ ...x,output:execFileSync('tar',['-xOf',archivePath,'runtime-hotfix/'+x.file.path],{maxBuffer:100*1024*1024}) }));
 if(outputs.some(x=>hash(x.output)!==x.file.afterSha256))throw Error('runtime_output_hash_mismatch');
 const save=value=>{const temporary=journal+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600});renameSync(temporary,journal);};
 const digestAt=dest=>{try{return hash(readFileSync(dest));}catch(e){if(e.code!=='ENOENT')throw e;return null;}};
 save({phase:'preparing',version:descriptor.version,beforeHashes:Object.fromEntries(inputs.map(x=>[x.file.path,x.digest]))});
 const changed=[];
 try{
  for(const x of outputs){
   if(digestAt(x.destination)!==x.digest)throw Error('runtime_changed_before_stage');
   if(x.digest===x.file.afterSha256)continue;
   if(x.digest!==null){const backup=path.join(journalDir,path.basename(x.destination)+'.'+x.digest+'.before');try{writeFileSync(backup,x.current,{mode:0o600,flag:'wx'});}catch(error){const meta=lstatSync(backup);if(error.code!=='EEXIST'||!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||meta.uid!==process.getuid()||hash(readFileSync(backup))!==x.digest)throw Error('runtime_backup_mismatch');}}
   const meta=x.meta??statSync(path.join(runtime,'dist/services-9PyB9Rj_.mjs'));
   const temporary=x.destination+'.'+randomUUID()+'.next';writeFileSync(temporary,x.output,{mode:meta.mode&0o777});chownSync(temporary,meta.uid,meta.gid);chmodSync(temporary,meta.mode&0o777);renameSync(temporary,x.destination);changed.push({...x,meta});
  }
  const result={changed:changed.length>0,version:descriptor.version,hashes:Object.fromEntries(inputs.map(x=>[x.file.path,hash(readFileSync(x.destination))]))};
  save({phase:'prepared',...result,preparedAtMs:Date.now(),pluginReinstalled:false});return result;
 }catch(error){
  for(const x of changed.reverse())if(digestAt(x.destination)===x.file.afterSha256){if(x.digest===null){unlinkSync(x.destination);continue;}const temporary=x.destination+'.rollback';writeFileSync(temporary,x.current,{mode:x.meta.mode&0o777});chownSync(temporary,x.meta.uid,x.meta.gid);chmodSync(temporary,x.meta.mode&0o777);renameSync(temporary,x.destination);}
  save({phase:'failed',version:descriptor.version,reason:/^[a-z_]+$/.test(error.message)?error.message:'runtime_preparation_failed'});throw error;
 }
}

export function prepareRuntimeCompanion({run,stateDir,configPath}) {
 const serviceStatus=JSON.parse(run(['gateway','status','--no-probe','--json']));
 const runtime=resolveManagedRuntime({serviceStatus,stateDir,configPath});
 const lanes=JSON.parse(run(['gateway','call','diagnostics.lanes','--params','{}','--json']));
 if(!isHostIdle(lanes))throw Error('host_activation_busy');
 const result=stageRuntimeCompanion({runtime,stateDir});
 const journal=path.join(stateDir,'sidewisp','runtime-companion-4013','result.json');let previous={};try{previous=JSON.parse(readFileSync(journal,'utf8'));}catch{}
 const prepared={...result,gatewayPid:serviceStatus.service.runtime.pid,activationRequired:result.native?false:result.changed||previous.phase!=='completed'||previous.version!==runtimeCompanionVersion};
 if(prepared.activationRequired){writeFileSync(journal+'.activation.tmp',JSON.stringify({...previous,phase:'prepared',...prepared})+'\n',{mode:0o600});renameSync(journal+'.activation.tmp',journal);}
 return prepared;
}

export function finalizeRuntimeCompanion({stateDir,prepared}) {
 const journal=path.join(stateDir,'sidewisp','runtime-companion-4013','result.json');let previous={};try{previous=JSON.parse(readFileSync(journal,'utf8'));}catch{}
 writeFileSync(journal+'.complete.tmp',JSON.stringify({...previous,...prepared,phase:'completed',completedAtMs:Date.now()})+'\n',{mode:0o600});renameSync(journal+'.complete.tmp',journal);
}
