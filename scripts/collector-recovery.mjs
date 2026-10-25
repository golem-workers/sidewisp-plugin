#!/usr/bin/env node
import {readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {repairCollector} from '../src/update/collector-maintenance.js';
import {isHostIdle,isRetainedWork} from '../src/update/hot-update.js';
import {coldActivateOpenClaw} from './cold-activate-openclaw.mjs';
const locked=process.argv[2]==='--kernel-lock',config=JSON.parse(process.argv[locked?3:2]);
const stateDir=process.env.OPENCLAW_STATE_DIR,configPath=process.env.OPENCLAW_CONFIG_PATH;
if(!path.isAbsolute(stateDir??'')||stateDir!==config.stateDir||!path.isAbsolute(configPath??''))throw Error('EXPLICIT_ACTIVE_PROFILE_REQUIRED');
const dir=path.join(stateDir,'sidewisp'),lock=path.join(dir,'update-status.json.kernel-lock');
if(!locked){const child=spawn('/usr/bin/flock',['--nonblock','--conflict-exit-code','3',lock,process.execPath,fileURLToPath(import.meta.url),'--kernel-lock',JSON.stringify(config)],{stdio:'inherit'});child.on('error',()=>process.exit(3));child.on('exit',code=>process.exit(code??1));}
else{
 const read=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw Error('INVALID_RECOVERY_STATE');}};
 const stateFile=path.join(dir,'collector-recovery.json'),credential=read(path.join(dir,'installation.json')),baseline=read(path.join(dir,'manager-baseline.json'));
 const previous=read(stateFile)??{},now=Date.now();
 const save=value=>{writeFileSync(stateFile+'.worker.tmp',JSON.stringify({...previous,...value})+'\n',{mode:0o600});renameSync(stateFile+'.worker.tmp',stateFile);};
 const bypass=[process.env.NO_PROXY,process.env.no_proxy,'127.0.0.1,localhost,::1'].filter(Boolean).join(',');
 const run=args=>execFileSync('openclaw',args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe'],env:{...process.env,NO_PROXY:bypass,no_proxy:bypass}});
 const rpc=name=>JSON.parse(run(['gateway','call',name,'--params','{}','--json']));
 try{
  const attempt=read(path.join(dir,'update-status.json')),journal=read(path.join(dir,'current-update.json'));
  if((attempt&&!['completed','idle','current'].includes(attempt.status))||(journal&&journal.status!=='completed'))throw Error('UPDATE_IN_PROGRESS');
  const result=await repairCollector({credential,baseline,endpoint:config.endpoint,stateId:createHash('sha256').update(realpathSync(stateDir)).digest('hex'),
   status:()=>rpc('sidewisp.status'),health:()=>rpc('health'),idle:()=>isHostIdle(rpc('diagnostics.lanes')),
   enabled:()=>{const c=read(configPath),p=c?.plugins?.entries?.sidewisp;return c?.plugins?.enabled!==false&&p?.enabled===true&&p.config?.enabled!==false&&(p.config?.endpoint??'https://api.sidewisp.com')===config.endpoint;},
   inspect:()=>{const p=JSON.parse(run(['plugins','inspect','sidewisp','--runtime','--json'])),root=p.install?.installPath??p.plugin?.rootDir;if(!path.isAbsolute(root??''))throw Error('INSTALLED_PLUGIN_UNAVAILABLE');return read(path.join(root,'package.json'));},
   verifyBinding:()=>{const c=read(path.join(dir,'installation.json'));if(c?.status!=='active'||c.installationId!==credential?.installationId||c.secret!==credential?.secret)throw Error('BINDING_CHANGED');},
   restart:()=>JSON.parse(run(['gateway','call','sidewisp.recover','--params',JSON.stringify({installationId:credential.installationId,endpoint:config.endpoint,stateId:baseline.stateId}),'--json'])),
   reload:()=>run(['plugins','reload','sidewisp','--accept-capabilities','--json']),activate:()=>coldActivateOpenClaw({run,stateDir,configPath})});
  save({status:result,failures:0,lastAttemptAtMs:now,nextAttemptAtMs:Date.now()+120000});
 }catch(error){const failures=(previous.failures??0)+1,busy=isRetainedWork(error)||error.message==='host_activation_busy';save({status:busy?'deferred':'unavailable',failures,lastAttemptAtMs:now,nextAttemptAtMs:Date.now()+Math.min(900000,60000*2**Math.min(failures-1,4)),reasonCode:busy?'HOST_RETAINED_WORK':/^[A-Z_]+$/.test(error.message)?error.message:'COLLECTOR_RECOVERY_FAILED'});process.exitCode=1;}
}
