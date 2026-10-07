import path from 'node:path';
import {realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const samePath=(a,b)=>{
  if (typeof a!=='string' || typeof b!=='string' || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  try {return realpathSync(a)===realpathSync(b);}catch {return false;}
};
// No service installation, force flag, session exclusion or policy fallback.
export async function coldActivateOpenClaw({run,stateDir,configPath}) {
  const status=JSON.parse(run(['gateway','status','--no-probe','--json']));
  const service=status.service,env=service?.command?.environment;
  if(service?.loaded!==true || service.runtime?.status!=='running'
    || !Number.isSafeInteger(service.runtime.pid) || service.runtime.pid<=0
    || service.targetRole==='diagnostic-only' || status.config?.mismatch===true
    || !samePath(status.config?.daemon?.path,configPath)
    || (env?.OPENCLAW_CONFIG_PATH && !samePath(env.OPENCLAW_CONFIG_PATH,configPath))
    || !samePath(env?.OPENCLAW_STATE_DIR ?? path.dirname(status.config.daemon.path),stateDir))
    throw new Error('managed_active_profile_required');
  let fence;
  try { fence=JSON.parse(run(['gateway','suspend','--request-id','sidewisp-activate-'+randomUUID(),'--json'])); }
  catch(error) {
    let result;try {result=JSON.parse(String(error.stdout));}catch {}
    if(result?.status==='busy')throw new Error('host_activation_busy');
    throw error;
  }
  if(fence?.status==='busy')throw new Error('host_activation_busy');
  if(fence?.status!=='ready' || typeof fence.suspensionId!=='string')throw new Error('host_activation_not_prepared');
  try { run(['gateway','restart','--json']); }
  catch(error) {
    // Release only our own reversible lease. Never retry/restart another target.
    try {run(['gateway','resume',fence.suspensionId,'--json']);}catch {}
    throw error;
  }
}
