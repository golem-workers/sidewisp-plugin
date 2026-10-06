#!/usr/bin/env node
// Run from an extracted, SHA-256-verified release. Public invitation only;
// credentials and approval proof never appear in arguments, logs or output.
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {installUpdateManager} from './install-update-manager.mjs';
import {isRetainedWork} from '../src/update/hot-update.js';
import {prepareConnection} from '../src/auth/prepare-connection.js';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
const args=process.argv.slice(2);const options={};
for(let i=0;i<args.length;i++){if(args[i]==='--enqueue')options.enqueue=true;else if(args[i]==='--update-only')options.updateOnly=true;else if(/^--(archive|sha256|endpoint|request-id|state-dir|expires-at-ms)$/.test(args[i]))options[args[i].slice(2)]=args[++i];else throw new Error('invalid_prepare_argument');}
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const stateDir=options['state-dir'];const endpoint=new URL(options.endpoint);
if(!path.isAbsolute(stateDir??'') || !path.isAbsolute(options.archive??'') || !/^[a-f0-9]{64}$/.test(options.sha256??'')
 || endpoint.protocol!=='https:' || endpoint.origin!==options.endpoint || (!options.updateOnly && !/^sw_pair_[A-Za-z0-9_-]{32}$/.test(options['request-id']??'')))throw new Error('invalid_prepare_input');
if(createHash('sha256').update(readFileSync(options.archive)).digest('hex')!==options.sha256)throw new Error('archive_hash_mismatch');
if(path.resolve(process.env.OPENCLAW_STATE_DIR??'')!==stateDir || !path.isAbsolute(process.env.OPENCLAW_CONFIG_PATH??''))throw new Error('explicit_active_profile_required');
const stateFile=path.join(stateDir,'sidewisp','prepare-status.json');mkdirSync(path.dirname(stateFile),{recursive:true,mode:0o700});
const writeState=s=>{writeFileSync(stateFile+'.tmp',JSON.stringify({...s,targetVersion:version,updatedAt:new Date().toISOString()}),{mode:0o600});renameSync(stateFile+'.tmp',stateFile);};
const run=args=>execFileSync('openclaw',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
if(options.enqueue){
 const safe=['HOME','PATH','USER','LOGNAME','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','OPENCLAW_GATEWAY_PORT','OPENCLAW_SYSTEMD_UNIT'];
 const env=Object.fromEntries(safe.filter(k=>typeof process.env[k]==='string').map(k=>[k,process.env[k]]));
 const unit='sidewisp-prepare-'+createHash('sha256').update(stateDir+(options['request-id']??version)).digest('hex').slice(0,16);
 const result=spawnSync('systemd-run',['--user','--quiet','--collect',`--unit=${unit}`,'--property=Type=exec',...Object.entries(env).map(([k,v])=>`--setenv=${k}=${v}`),process.execPath,fileURLToPath(import.meta.url),...args.filter(a=>a!=='--enqueue')],{env,encoding:'utf8',stdio:'pipe'});
 if(result.status!==0)throw new Error('background_preparation_not_started');
 console.log(JSON.stringify({status:'preparation_queued',nextAction:'Finish this setup turn so the host can release retained plugin work. Preparation continues automatically; approve in Sidewisp only for a new connection.'}));
}else{
 try{
  const status=()=>{try{return JSON.parse(run(['gateway','call','sidewisp.status','--params','{}','--json']));}catch(e){if(/unknown method[: ]+sidewisp\.status/i.test(String(e.stderr)+' '+String(e.stdout)))return null;throw e;}};
  const client=createDeviceAuthorizationClient({endpoint:endpoint.origin,stateDir});
  await prepareConnection({targetVersion:version,endpoint:endpoint.origin,updateOnly:options.updateOnly,
   expiresAtMs:options['expires-at-ms'] === undefined ? undefined : Number(options['expires-at-ms']),
   inspect:status,persist:s=>writeState({status:s.stage,...s}),
   // Do not wait for collector readiness before configuring a fresh install.
   // Host retained-work refusal stops this attempt; it never permits bypass.
   install:async()=>run(['plugins','install',options.archive,'--force','--accept-capabilities']),
   activate:async()=>{
    run(['config','set','plugins.entries.sidewisp.config.endpoint',endpoint.origin]);
    run(['plugins','reload','sidewisp','--accept-capabilities','--json']);
   },
   upgrade:async()=>{
    runHelper();
    const state=JSON.parse(readFileSync(path.join(stateDir,'sidewisp/update-status.json'),'utf8'));
    if(!['completed','skipped'].includes(state.status))throw new Error('update_not_applied');
   },
   ensureManager:async()=>installUpdateManager({stateDir,endpoint:endpoint.origin,upgrade:true}),
   begin:async()=>{
    return client.begin({id:options['request-id'],runtime:'openclaw'});
   },
  });
 }catch(e){writeState({status:'blocked',reason:isRetainedWork(e)?'host_retained_work':/^[a-z_]+$/i.test(e.message)?e.message:'preparation_failed'});process.exitCode=1;}
}
function runHelper(){
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:version,targetSpec:`git:github.com/golem-workers/sidewisp-plugin@v${version}`,
 sha256:options.sha256,archivePath:options.archive,restartDelaySeconds:30,stateFile:path.join(stateDir,'sidewisp/update-status.json')};
 execFileSync(process.execPath,[fileURLToPath(new URL('./openclaw-update-helper.mjs',import.meta.url)),JSON.stringify(d)],{stdio:'pipe',timeout:900000});
}
