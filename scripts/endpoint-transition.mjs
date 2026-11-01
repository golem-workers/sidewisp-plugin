#!/usr/bin/env node
import fs from 'node:fs/promises';
import {realpathSync,existsSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
import {createFileCredentialStore} from '../src/auth/credentials.js';
import {installUpdateManager} from './install-update-manager.mjs';
import { planEndpointTransition,beginEndpointTransition,pollEndpointTransition,verifyEndpointTransitionReady,activateEndpointTransition } from '../src/auth/endpoint-transition.js';
try {
 const [action,file,confirmation,requestId,...extra]=process.argv.slice(2);
 if(!file?.startsWith('/'))throw Error('absolute_plan_file_required');
 const run=args=>execFileSync('openclaw',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
 let result;
 if(action==='plan'){
  if(extra.length)throw Error('invalid_transition_argument');
  const plan=await planEndpointTransition({stateDir:process.env.OPENCLAW_STATE_DIR,configFile:process.env.OPENCLAW_CONFIG_PATH,...(confirmation?{targetEndpoint:confirmation}:{}),...(requestId?{sourceEndpoint:requestId}:{})});
  await fs.writeFile(file,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  result={status:'confirmation_required',confirmation:plan.confirmation,sourceEndpoint:plan.sourceEndpoint,targetEndpoint:plan.targetEndpoint,bindingChanged:false};
 } else {
  const plan=JSON.parse(await fs.readFile(file,'utf8'));
  if(path.resolve(process.env.OPENCLAW_STATE_DIR??'')!==plan.stateDir||path.resolve(process.env.OPENCLAW_CONFIG_PATH??'')!==plan.configFile)throw Error('explicit_active_profile_required');
  if(action==='connect'){
   if(confirmation!==plan.confirmation)throw Error('explicit_host_confirmation_required');
   if(extra.includes('--enqueue')) {
    const unit='sidewisp-transition-'+createHash('sha256').update(plan.confirmation+requestId).digest('hex').slice(0,16);
    let active=false;try{active=execFileSync('systemctl',['--user','is-active',unit+'.service'],{encoding:'utf8',stdio:'pipe'}).trim()==='active';}catch(e){if(![3,4].includes(e.status))throw e;}
    if(!active){const keys=['HOME','PATH','USER','LOGNAME','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','OPENCLAW_GATEWAY_PORT','OPENCLAW_SYSTEMD_UNIT','NODE_EXTRA_CA_CERTS'];
     execFileSync('systemd-run',['--user','--quiet','--collect','--no-block','--unit='+unit,'--property=Type=exec','--property=UMask=0077','--property=RuntimeMaxSec=900',...keys.filter(k=>typeof process.env[k]==='string').map(k=>'--setenv='+k+'='+process.env[k]),'--',process.execPath,fileURLToPath(import.meta.url),'connect',file,confirmation,requestId,'--supervised'],{stdio:'pipe'});
    }
    result={status:'transition_queued',unit,bindingChanged:false};
   }else if(extra.includes('--supervised')){
    const client=createDeviceAuthorizationClient({endpoint:plan.targetEndpoint,stateDir:plan.candidateStateDir});
    const statusFile=path.join(path.dirname(plan.candidateStateDir),'connection-status.json');
    const mark=async(stage,reasonCode)=>{await fs.writeFile(statusFile,JSON.stringify({stage,...(reasonCode?{reasonCode}:{}),updatedAtMs:Date.now()}),{mode:0o600});await client.reportPreparation({id:requestId,stage,...(reasonCode?{reasonCode}:{})}).catch(()=>{});};
    const deadline=Date.now()+14*60_000;
    try {
     if(!await createFileCredentialStore({stateDir:plan.candidateStateDir}).read()) {
      await beginEndpointTransition({plan,confirmation,requestId});
      // Retain only this request's proof for post-ACK progress reports.
      const proof=await fs.readFile(path.join(plan.candidateStateDir,'sidewisp/device-authorization.json'));
      const dir=path.join(plan.candidateStateDir,'sidewisp/prepare-authorizations');await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.writeFile(path.join(dir,requestId+'.json'),proof,{mode:0o600});
      for(;;){if(Date.now()>=deadline)throw Error('fresh_invitation_required');const next=await pollEndpointTransition({plan});if(next.status==='credential_saved')break;if(next.status!=='pending')throw Error('fresh_invitation_required');await new Promise(r=>setTimeout(r,2000));}
     }
     await verifyEndpointTransitionReady({plan});
     for(;;){if(Date.now()>=deadline)throw Error('host_idle_timeout');
      const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'activate',file,confirmation],{encoding:'utf8'});
      if(child.status===0){result=JSON.parse(child.stdout);await fs.writeFile(statusFile,JSON.stringify({...result,updatedAtMs:Date.now()}),{mode:0o600});break;}
      const reason=child.stderr.trim();if(!['host_activation_busy','manager_update_in_progress'].includes(reason))throw Error('transition_activation_failed');
      await mark('waiting_for_host_idle','HOST_RETAINED_WORK');await new Promise(r=>setTimeout(r,3000));
     }
    }catch(e){await mark('blocked',['fresh_invitation_required','host_idle_timeout','existing_endpoint_mismatch'].includes(e.message)?e.message:'transition_activation_failed');throw e;}
   }else throw Error('enqueue_transition_required');
  }else if(action==='begin')result=await beginEndpointTransition({plan,confirmation,requestId});
  else if(action==='poll')result=await pollEndpointTransition({plan});
  else if(action==='ready')result=await verifyEndpointTransitionReady({plan});
  else if(action==='activate'){
   if(!extra.includes('--locked')) {
    const child=spawnSync('/usr/bin/flock',['--nonblock','--conflict-exit-code','3',path.join(plan.stateDir,'sidewisp/update-status.json.kernel-lock'),process.execPath,fileURLToPath(import.meta.url),...process.argv.slice(2),'--locked'],{stdio:'inherit'});if(child.status===3)console.error('manager_update_in_progress');process.exit(child.status??1);
   }
   const unit='sidewisp-update-manager-'+createHash('sha256').update(plan.stateDir).digest('hex').slice(0,12)+'.service';let manager=false;
   const host={
    async validate(){
     const snapshot=JSON.parse(run(['gateway','status','--no-probe','--json']));const s=snapshot.service,e=s?.command?.environment;
     if(s?.loaded!==true||s.runtime?.status!=='running'||s.targetRole==='diagnostic-only'||snapshot.config?.mismatch===true||realpathSync(snapshot.config?.daemon?.path)!==realpathSync(plan.configFile)||realpathSync(e?.OPENCLAW_STATE_DIR??path.dirname(snapshot.config.daemon.path))!==realpathSync(plan.stateDir))throw Error('managed_active_profile_required');
     const f=path.join(plan.stateDir,'sidewisp/manager/config.json');manager=existsSync(f);
     if(manager){const c=JSON.parse(readFileSync(f));if(c.stateDir!==plan.stateDir||c.endpoint!==plan.sourceEndpoint)throw Error('manager_binding_mismatch');}
    },
    async suspend(){let v;try{v=JSON.parse(run(['gateway','suspend','--request-id','sidewisp-transition-'+randomUUID(),'--json']));}catch(e){try{if(JSON.parse(String(e.stdout)).status==='busy')throw Error('host_activation_busy');}catch(x){if(x.message==='host_activation_busy')throw x;}throw e;}if(v.status==='busy')throw Error('host_activation_busy');if(v.status!=='ready'||!v.suspensionId)throw Error('host_activation_not_prepared');return v.suspensionId;},
    async resume(id){run(['gateway','resume',id,'--json']);},
    async stop(){if(manager)execFileSync('systemctl',['--user','stop',unit],{stdio:'pipe'});run(['gateway','stop','--json']);},
    async start(endpoint){if(manager)installUpdateManager({stateDir:plan.stateDir,endpoint,upgrade:true});run(['gateway','start','--json']);}
   };
   result=await activateEndpointTransition({plan,confirmation,host});
  }else throw Error('expected_plan_begin_poll_ready_or_activate');
 }
 const {userCode,verificationUri,...publicResult}=result;
 console.log(JSON.stringify(publicResult));
} catch(error){console.error(/^[a-z_0-9]+$/.test(error.message)?error.message:'endpoint_transition_failed');process.exitCode=1;}
