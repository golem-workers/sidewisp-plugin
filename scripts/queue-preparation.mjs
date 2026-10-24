import {ensureUserAutostart} from '../src/auth/user-autostart.js';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const quote=s=>'"'+s.replace(/%/g,'%%').replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
// One durable supervisor per profile, independent of the Gateway and caller's exec.
export function queuePreparation({stateDir,version,sha256,endpoint,args,script,environment=process.env,run=execFileSync,ensureAutostart=ensureUserAutostart}) {
 const dir=path.join(stateDir,'sidewisp');mkdirSync(dir,{recursive:true,mode:0o700});
 const jobFile=path.join(dir,'prepare-job.json');
 const identity=createHash('sha256').update(JSON.stringify({version,sha256,endpoint,args})).digest('hex');
 const unit='sidewisp-prepare-'+createHash('sha256').update(stateDir).digest('hex').slice(0,16)+'.service';
 let old;try{old=JSON.parse(readFileSync(jobFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let active;try{active=String(run('systemctl',['--user','is-active',unit],{encoding:'utf8',stdio:'pipe'})).trim();}catch(e){if(![3,4].includes(e.status))throw e;active='inactive';}
 if(['active','activating','reloading'].includes(active)) {
  if(old?.identity!==identity)throw Error('another_preparation_pending');
  ensureAutostart({run});
  return {status:'preparation_queued',unit,resumed:true};
 }
 if(old?.identity!==identity && !args.includes('--update-only')) {
  const i=args.indexOf('--expires-at-ms');const expiry=i<0?undefined:Number(args[i+1]);
  if(expiry!==undefined&&(!Number.isSafeInteger(expiry)||expiry<=Date.now()))throw Error('fresh_invitation_required');
 }
 const job=old?.identity===identity?old:{identity,deadlineMs:Date.now()+3600000};
 if(job.terminal)return ['completed','approval_pending','connection_pending'].includes(job.terminal) ? {status:job.terminal,unit} : {status:'blocked',reason:job.terminal,unit};
 ensureAutostart({run});
 const unitDir=path.join(environment.XDG_CONFIG_HOME??path.join(environment.HOME,'.config'),'systemd','user');mkdirSync(unitDir,{recursive:true});
 const unitFile=path.join(unitDir,unit);
 const envKeys=['HOME','PATH','USER','LOGNAME','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','OPENCLAW_GATEWAY_PORT','OPENCLAW_SYSTEMD_UNIT'];
 const text='[Unit]\nDescription=Sidewisp durable preparation\nStartLimitIntervalSec=0\n[Service]\nType=exec\nExecStart='+[process.execPath,script,...args,'--supervised'].map(quote).join(' ')+'\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=1 2 3\nRestartForceExitStatus=SIGTERM SIGINT SIGHUP\nRuntimeMaxSec=900\nTimeoutStopSec=10\nKillMode=control-group\nUMask=0077\n'+envKeys.filter(k=>typeof environment[k]==='string').map(k=>'Environment='+quote(k+'='+environment[k])).join('\n')+'\n[Install]\nWantedBy=default.target\n';
 // Do not replace an unrelated or owner-customized unit.
 if(existsSync(unitFile)&&!readFileSync(unitFile,'utf8').startsWith('[Unit]\nDescription=Sidewisp durable preparation\n'))throw Error('preparation_unit_review_required');
 writeFileSync(jobFile+'.tmp',JSON.stringify(job),{mode:0o600});renameSync(jobFile+'.tmp',jobFile);
 writeFileSync(unitFile,text,{mode:0o600});
 run('systemctl',['--user','daemon-reload'],{stdio:'pipe'});
 run('systemctl',['--user','enable','--now',unit],{stdio:'pipe'});
 return {status:'preparation_queued',unit};
}
