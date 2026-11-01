import path from 'node:path';
import {realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const samePath=(a,b)=>{
  if (typeof a!=='string' || typeof b!=='string' || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  try {return realpathSync(a)===realpathSync(b);}catch {return false;}
};
// No service installation, force flag, session exclusion or policy fallback.
export async function coldActivateOpenClaw({run,stateDir,configPath,sleep=ms=>new Promise(r=>setTimeout(r,ms)),restartProbeAttempts=24}) {
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
    // Restart CLI readiness can time out while systemd is still bringing up the
    // new process. Observe that exact service; never send a second restart.
    const timeout=/timed?\s*out|timeout|ETIMEDOUT/i.test([error.message,error.stdout,error.stderr,error.code].join(' '));
    if(timeout) {
      for(let n=0;n<restartProbeAttempts;n++) {
        await sleep(5000);
        let next;try {next=JSON.parse(run(['gateway','status','--no-probe','--json']));}catch {continue;}
        const ns=next.service,ne=ns?.command?.environment;
        if(ns?.loaded!==true || ns.targetRole==='diagnostic-only' || next.config?.mismatch===true
          || !samePath(next.config?.daemon?.path,configPath)
          || (ne?.OPENCLAW_CONFIG_PATH && !samePath(ne.OPENCLAW_CONFIG_PATH,configPath))
          || !samePath(ne?.OPENCLAW_STATE_DIR ?? path.dirname(next.config?.daemon?.path ?? ''),stateDir)) break;
        if(ns.runtime?.status==='running' && Number.isSafeInteger(ns.runtime.pid)
          && ns.runtime.pid>0 && ns.runtime.pid!==service.runtime.pid) return;
      }
    }
    // Release only our own reversible lease. Never retry/restart another target.
    try {run(['gateway','resume',fence.suspensionId,'--json']);}catch {}
    throw error;
  }
}

// A stopped, explicitly matched service can be repaired without plugin RPC.
// A running-but-unreachable host cannot be declared idle or forcibly restarted.
export async function startStoppedOpenClaw({run,stateDir,configPath,prepare}) {
 const snapshot=JSON.parse(run(['gateway','status','--no-probe','--json']));
 const service=snapshot.service,env=service?.command?.environment;
 if(service?.runtime?.status==='running')return false;
 if(service?.loaded!==true||service.runtime?.status!=='stopped'
  || (service.runtime.pid!=null&&service.runtime.pid!==0)
  || service.targetRole==='diagnostic-only'||snapshot.config?.mismatch===true
  || !samePath(snapshot.config?.daemon?.path,configPath)
  || (env?.OPENCLAW_CONFIG_PATH&&!samePath(env.OPENCLAW_CONFIG_PATH,configPath))
  || !samePath(env?.OPENCLAW_STATE_DIR??path.dirname(snapshot.config.daemon.path),stateDir))throw Error('managed_active_profile_required');
 await prepare();run(['gateway','start','--json']);return true;
}
