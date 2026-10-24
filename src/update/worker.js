// One profile-scoped worker, owned by systemd rather than manager/Gateway cgroups.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {validManagedDirective} from './manager.js';
export const workerUnit=stateDir=>'sidewisp-update-worker-'+createHash('sha256').update(realpathSync(stateDir)).digest('hex').slice(0,12)+'.service';
const keys=['HOME','PATH','USER','LOGNAME','LANG','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','OPENCLAW_STATE_DIR','OPENCLAW_CONFIG_PATH','OPENCLAW_PROFILE','OPENCLAW_GATEWAY_PORT','OPENCLAW_SYSTEMD_UNIT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS'];
export async function workerActive({stateDir,run}) {
 const {stdout}=await run('systemctl',['--user','show',workerUnit(stateDir),'--property=ActiveState','--value'],{timeout:15000});
 const state=stdout.trim();
 if(['active','activating','deactivating','reloading'].includes(state))return true;
 if(['inactive','failed',''].includes(state))return false;
 throw Error('WORKER_STATE_UNAVAILABLE');
}
export async function startUpdateWorker({stateDir,directive,helper,run,environment=process.env}) {
 if(environment.OPENCLAW_STATE_DIR!==stateDir||!path.isAbsolute(environment.OPENCLAW_CONFIG_PATH??'')||!path.isAbsolute(helper))throw Error('EXPLICIT_ACTIVE_PROFILE_REQUIRED');
 return run('systemd-run',['--user','--quiet','--collect','--no-block','--unit='+workerUnit(stateDir),
  '--property=Type=exec','--property=UMask=0077',
  ...keys.filter(k=>typeof environment[k]==='string').map(k=>'--setenv='+k+'='+environment[k]),
  '--',process.execPath,helper,JSON.stringify(directive)],{timeout:15000});
}
export function recoverableDirective({journal,credential,endpoint,stateDir,attempt}) {
 if(['failed','rolled_back','skipped'].includes(attempt?.status))return null;
 if(journal?.schema!=='sidewisp.current-update.v1'||['completed','failed'].includes(journal.status)
  || !validManagedDirective(journal.directive)||journal.baseline?.installationId!==credential?.installationId
  || credential?.status!=='active'||journal.baseline?.endpoint!==endpoint
  || journal.baseline?.stateId!==createHash('sha256').update(realpathSync(stateDir)).digest('hex')
  || journal.directive.stateFile!==path.join(stateDir,'sidewisp','update-status.json'))return null;
 return journal.directive;
}
