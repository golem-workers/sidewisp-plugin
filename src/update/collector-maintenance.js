// Liveness is independent of an immutable update attempt. Never reopen completed
// or failed update journals to repair the already installed plugin.
export const collectorReady=s=>s?.enabled===true&&s.running===true&&s.connectionReadiness?.ready===true;
export function maintenancePlan({current,attempt,journal,baseline,credential,endpoint,stateId,state={},now=Date.now()}) {
 if(collectorReady(current))return {due:false,state:{status:'healthy',failures:0,checkedAtMs:now}};
 if(credential?.status!=='active'||baseline?.installationId!==credential.installationId||baseline?.endpoint!==endpoint||baseline?.stateId!==stateId)return {due:false,state};
 if(current&&(current.enabled!==true||current.endpoint!==endpoint||current.installation?.installationId!==credential.installationId||current.version!==baseline.version))return {due:false,state};
 if((attempt&&!['completed','idle','current'].includes(attempt.status))||(journal&&journal.status!=='completed'))return {due:false,state};
 const next={...state,unhealthySinceMs:state.unhealthySinceMs??now,checkedAtMs:now};
 return {due:now-next.unhealthySinceMs>=120000&&now>=(next.nextAttemptAtMs??0),state:next};
}
export async function repairCollector({status,health,inspect,credential,baseline,endpoint,stateId,enabled,idle,reload,restart,activate,verifyBinding,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxAttempts=24}) {
 if(credential?.status!=='active'||baseline?.installationId!==credential.installationId||baseline?.endpoint!==endpoint||baseline?.stateId!==stateId)throw Error('RECOVERY_BASELINE_REQUIRED');
 if(!enabled())throw Error('COLLECTOR_DISABLED');
 await verifyBinding();
 let current;try{current=await status();}catch{if(!(await health())?.ok)throw Error('GATEWAY_UNAVAILABLE');}
 const verify=current=>{if(current&&(current.endpoint!==endpoint||current.installation?.installationId!==credential.installationId||current.connectionReadiness?.stateId!==stateId))throw Error('BINDING_CHANGED');if(current?.enabled===false)throw Error('COLLECTOR_DISABLED');};
 verify(current);if(collectorReady(current))return 'healthy';
 const installed=await inspect();
 if(installed.version!==baseline.version||(current&&current.version!==installed.version))throw Error('INSTALLED_VERSION_CHANGED');
 if(!await idle())return 'deferred';
 await verifyBinding();if(!enabled())throw Error('COLLECTOR_DISABLED');
 if(current?.recovery?.available===true&&restart)await restart();
 else if(current?.connectionReadiness?.activationRequired===true)await activate();
 else await reload(); // Host independently rejects retained-work replacement.
 for(let n=0;n<maxAttempts;n++){
  await sleep(5000);await verifyBinding();
  try{current=await status();}catch{continue;}
  verify(current);if(current?.connectionReadiness?.activationRequired===true){if(!await idle())return 'deferred';await activate();continue;}
  if(current.version!==installed.version)throw Error('INSTALLED_VERSION_CHANGED');
  if(collectorReady(current))return 'recovered';
 }
 throw Error('COLLECTOR_RECOVERY_PENDING');
}
