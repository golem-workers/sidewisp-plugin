// Forward-only convergence. Busy admission is never bypassed; no old package is installed.
import {isRetainedWork} from './hot-update.js';
export async function convergeCurrentRelease({targetVersion,status,idle,install,reload,activate,verify,write,recoverStopped,
 journal,sleep=ms=>new Promise(r=>setTimeout(r,ms)),maxAttempts=120}) {
 let bad=0;
 for(let n=0;n<maxAttempts;n++) {
  let current;
  try {current=await status();} catch(error) {
   // RPC loss following our activation is transient, not an invitation to force restart.
   if(!journal.mutated)throw error;
   if(recoverStopped) {if(await recoverStopped()){journal.activated=true;write({status:'verifying',phase:'started'});}}
   write({status:'verifying',reasonCode:'WAITING_FOR_GATEWAY'});await sleep(5000);continue;
  }
  if(current?.version===targetVersion && current.enabled===true && current.running===true && current.connectionReadiness?.ready===true) {
   await verify(current);write({status:'completed'});return 'completed';
  }
  if(!await idle(current)) {write({status:'waiting_for_idle',reasonCode:'ACTIVE_WORK'});await sleep(5000);continue;}
  if(current?.version===targetVersion && current.connectionReadiness?.activationRequired===true) {
   if(!journal.activated) {
    // Cold activation mutates the host even when the target was installed earlier.
    // Persist ownership before the restart so a crashed helper can recover it.
    journal.staged=true;journal.mutated=true;
    try {write({status:'activating',phase:'activation_intent'});await activate();journal.activated=true;write({status:'verifying',phase:'activated'});}
    catch(error){if(error.message!=='host_activation_busy')throw error;write({status:'waiting_for_idle',reasonCode:'HOST_RETAINED_WORK'});}
   }
   await sleep(5000);continue;
  }
  if(!journal.staged) {
   if((journal.installCount??0)>=2)throw Error('CURRENT_RELEASE_UNHEALTHY');
   journal.installCount=(journal.installCount??0)+1;journal.mutated=true;
   write({status:'updating',phase:'install_intent'});
   try {await install();journal.staged=true;write({status:'verifying',phase:'installed'});}
   catch(error) {
    if(!isRetainedWork(error))throw error;
    journal.staged=true;write({status:'waiting_for_idle',reasonCode:'HOST_RETAINED_WORK',phase:'installed'});
   }
   await sleep(5000);continue;
  }
  if(current?.version!==targetVersion) {
   try {write({status:'verifying',phase:'reload_intent'});await reload();write({status:'verifying',phase:'reloaded'});}
   catch(error){if(!isRetainedWork(error))throw error;write({status:'waiting_for_idle',reasonCode:'HOST_RETAINED_WORK'});}
   await sleep(5000);continue;
  }
  write({status:'verifying',reasonCode:'WAITING_FOR_COLLECTOR'});
  if(++bad>=12) {
   bad=0;if((journal.installCount??0)>=2)throw Error('CURRENT_RELEASE_UNHEALTHY');
   journal.staged=false;journal.activated=false;write({status:'repairing',phase:'repair_intent'});
  }
  await sleep(5000);
 }
 write({status:'deferred',reasonCode:'IDLE_WINDOW_TIMEOUT'});return 'deferred';
}
