import {readFileSync,realpathSync,existsSync,mkdirSync,mkdtempSync,cpSync,renameSync,rmSync} from 'node:fs';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {isNewerVersion} from './directive.js';
// An old manager can deliver this package. The package then upgrades its private
// manager copy outside both service cgroups, without asking the model to run it.
export async function adoptInstalledManager({stateDir,endpoint,environment=process.env,run=promisify(execFile)}) {
 // Default Gateway services omit overrides; SDK state is authoritative.
 if(!path.isAbsolute(stateDir??'')||(environment.OPENCLAW_STATE_DIR&&environment.OPENCLAW_STATE_DIR!==stateDir))return false;
 environment={...environment,OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:environment.OPENCLAW_CONFIG_PATH??path.join(stateDir,'openclaw.json')};
 if(!path.isAbsolute(environment.OPENCLAW_CONFIG_PATH)||!existsSync(environment.OPENCLAW_CONFIG_PATH))return false;
 const dir=path.join(stateDir,'sidewisp/manager'),configFile=path.join(dir,'config.json');if(!existsSync(configFile)||!existsSync(path.join(dir,'current')))return false;
 const config=JSON.parse(readFileSync(configFile,'utf8'));if(config.stateDir!==stateDir||config.endpoint!==endpoint)throw Error('MANAGER_BINDING_MISMATCH');
 const installed=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version;
 const prior=JSON.parse(readFileSync(path.join(dir,'current/package.json'),'utf8')).version;if(!isNewerVersion(installed,prior))return false;
 const unit='sidewisp-manager-adoption-'+createHash('sha256').update(realpathSync(stateDir)).digest('hex').slice(0,12)+'.service';
 const {stdout}=await run('systemctl',['--user','show',unit,'--property=ActiveState','--value'],{timeout:15000});if(['active','activating','deactivating'].includes(stdout.trim()))return true;
 // The serving host may retire its captured plugin tree during activation.
 // Stage the private immutable manager bundle before detaching the worker.
 const release=path.join(dir,'releases',installed);
 if(!existsSync(release)){
  mkdirSync(path.dirname(release),{recursive:true,mode:0o700});
  const temp=mkdtempSync(path.join(path.dirname(release),'.adoption-'));
  try{const root=fileURLToPath(new URL('../../',import.meta.url));for(const entry of ['src','scripts','package.json'])cpSync(path.join(root,entry),path.join(temp,entry),{recursive:true});renameSync(temp,release);}
  finally{rmSync(temp,{recursive:true,force:true});}
 }
 if(JSON.parse(readFileSync(path.join(release,'package.json'),'utf8')).version!==installed||!existsSync(path.join(release,'scripts/adopt-installed-manager.mjs')))throw Error('MANAGER_RELEASE_REVIEW_REQUIRED');
 const keys=['HOME','PATH','USER','LOGNAME','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','OPENCLAW_GATEWAY_PORT','OPENCLAW_SYSTEMD_UNIT'];
 await run('systemd-run',['--user','--quiet','--collect','--no-block','--unit='+unit,'--property=Type=exec','--property=UMask=0077',...keys.filter(k=>typeof environment[k]==='string').map(k=>'--setenv='+k+'='+environment[k]),'--',process.execPath,path.join(release,'scripts/adopt-installed-manager.mjs'),endpoint],{timeout:15000});return true;
}
