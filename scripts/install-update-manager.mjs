#!/usr/bin/env node
import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync,symlinkSync,renameSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isNewerVersion} from '../src/update/directive.js';
export function installUpdateManager({stateDir,endpoint,run=execFileSync,environment=process.env,platform=process.platform,upgrade=false}) {
 if(platform!=='linux')throw Error('MANAGER_REQUIRES_SYSTEMD_USER');
 if(!path.isAbsolute(stateDir??'')||!path.isAbsolute(environment.OPENCLAW_CONFIG_PATH??'')||environment.OPENCLAW_STATE_DIR!==stateDir)throw Error('EXPLICIT_ACTIVE_PROFILE_REQUIRED');
 const url=new URL(endpoint);if(url.protocol!=='https:'||url.origin!==endpoint)throw Error('INVALID_ENDPOINT');
 const root=fileURLToPath(new URL('../',import.meta.url)),version=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version;
 const dir=path.join(stateDir,'sidewisp','manager');
 const link=path.join(dir,'current');
 let upgradeNeeded=false;let previousRelease;
 if(upgrade && existsSync(link)){
  const previous=realpathSync(link);
  if(path.dirname(previous)!==path.join(dir,'releases') || !existsSync(path.join(previous,'package.json')))throw Error('MANAGER_CURRENT_REVIEW_REQUIRED');
  const priorVersion=JSON.parse(readFileSync(path.join(previous,'package.json'),'utf8')).version;
  if(!/^\d+\.\d+\.\d+$/.test(priorVersion))throw Error('MANAGER_CURRENT_REVIEW_REQUIRED');
  if(priorVersion!==version){
   if(isNewerVersion(priorVersion,version))throw Error('NEWER_MANAGER_INSTALLED');
   if(existsSync(path.join(stateDir,'sidewisp','update-status.json.lock')))throw Error('MANAGER_UPDATE_IN_PROGRESS');
   upgradeNeeded=true;previousRelease=previous;
  }
 }
 mkdirSync(dir,{recursive:true,mode:0o700});
 const release=path.join(dir,'releases',version);
 if(!existsSync(release)){mkdirSync(release,{recursive:true,mode:0o700});for(const entry of ['src','scripts','package.json'])cpSync(path.join(root,entry),path.join(release,entry),{recursive:true});}
 const configFile=path.join(dir,'config.json');
 const config={schema:'sidewisp.update-manager.v1',stateDir,endpoint};
 if(existsSync(configFile)){const old=JSON.parse(readFileSync(configFile,'utf8'));if(old.stateDir!==stateDir||old.endpoint!==endpoint)throw Error('MANAGER_BINDING_MISMATCH');}
 if(!existsSync(configFile))writeFileSync(configFile,JSON.stringify(config)+'\n',{mode:0o600});
 // The runtime never imports live plugin code; installation/upgrade is explicit.
 if(!existsSync(link)){symlinkSync(release,link+'.tmp');renameSync(link+'.tmp',link);}
 const quote=s=>'"'+s.replace(/%/g,'%%').replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
 const unit='sidewisp-update-manager-'+createHash('sha256').update(stateDir).digest('hex').slice(0,12)+'.service';
 const unitDir=path.join(environment.XDG_CONFIG_HOME??path.join(environment.HOME,'.config'),'systemd','user');mkdirSync(unitDir,{recursive:true});
 const keys=['HOME','PATH','USER','LOGNAME','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','OPENCLAW_GATEWAY_PORT','OPENCLAW_SYSTEMD_UNIT'];
 const text='[Unit]\nDescription=Sidewisp independent update manager\nAfter=network-online.target\n[Service]\nType=simple\nExecStart='+[process.execPath,path.join(link,'scripts/managed-updater.mjs'),configFile].map(quote).join(' ')+'\nRestart=on-failure\nRestartSec=30\nUMask=0077\nTimeoutStopSec=900\n'+keys.filter(k=>typeof environment[k]==='string').map(k=>'Environment='+quote(k+'='+environment[k])).join('\n')+'\n[Install]\nWantedBy=default.target\n';
 // Existing units may contain owner policy and environment customizations.
 // Never replace them as a side effect of enrollment.
 const unitFile=path.join(unitDir,unit);
 if(existsSync(unitFile)){
  const existing=readFileSync(unitFile,'utf8');
  const expectedStart=text.split('\n').find(line=>line.startsWith('ExecStart='));
  if(existing.split('\n').filter(line=>line.startsWith('ExecStart=')).join('\n')!==expectedStart)throw Error('MANAGER_UNIT_REVIEW_REQUIRED');
 }else writeFileSync(unitFile,text,{mode:0o600});
 if(upgradeNeeded){
  // Explicitly upgrade only the independent manager, never the Gateway.
  // An active helper must finish; no SIGKILL, lock removal or idle bypass.
  run('systemctl',['--user','stop',unit],{stdio:'pipe'});
  if(existsSync(path.join(stateDir,'sidewisp','update-status.json.lock'))){
   run('systemctl',['--user','start',unit],{stdio:'pipe'});throw Error('MANAGER_UPDATE_IN_PROGRESS');
  }
  symlinkSync(release,link+'.upgrade.tmp');renameSync(link+'.upgrade.tmp',link);
 }
 try {
  run('systemctl',['--user','daemon-reload'],{stdio:'pipe'});run('systemctl',['--user','enable','--now',unit],{stdio:'pipe'});
 } catch(error) {
  if(upgradeNeeded){
   symlinkSync(previousRelease,link+'.restore.tmp');renameSync(link+'.restore.tmp',link);
   run('systemctl',['--user','start',unit],{stdio:'pipe'});
  }
  throw error;
 }
 return {status:'enabled',unit,configFile,managerVersion:JSON.parse(readFileSync(path.join(realpathSync(link),'package.json'),'utf8')).version};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const stateDir=process.env.OPENCLAW_STATE_DIR,endpoint=process.argv[2];if(process.argv.slice(3).some(arg=>arg!=='--upgrade'))throw Error('INVALID_MANAGER_ARGUMENT');console.log(JSON.stringify(installUpdateManager({stateDir,endpoint,upgrade:process.argv.includes('--upgrade')})));
}
