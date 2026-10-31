import {mkdirSync,lstatSync,openSync,writeFileSync,closeSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const STEPS=new Set(['queueing','inspecting','preparing_runtime','installing','activating','upgrading','activating_runtime','verifying','waiting_for_readiness','waiting_for_host_idle','requesting_approval']);
const CODES=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ECONNREFUSED','ECONNRESET']);
// Raw stderr is LOCAL ONLY, never part of protocol/state/public command output.
export function recordPreparationFailure({stateDir,step,error}) {
 const directory=path.join(stateDir,'sidewisp','preparation-diagnostics');
 mkdirSync(directory,{recursive:true,mode:0o700});
 const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error('private_diagnostics_directory_required');
 const diagnosticId=randomUUID(),code=CODES.has(error?.code)?error.code:Number.isInteger(error?.status)?'COMMAND_FAILED':'PREPARATION_EXCEPTION';
 const metadata={diagnosticId,step:STEPS.has(step)?step:'inspecting',code};
 const fd=openSync(path.join(directory,diagnosticId+'.json'),'wx',0o600);
 try{writeFileSync(fd,JSON.stringify({...metadata,at:new Date().toISOString(),errorName:String(error?.name??'Error').slice(0,128),message:String(error?.message??'').slice(0,4096),stderr:String(error?.stderr??'').slice(0,16384)}));}finally{closeSync(fd);}
 return metadata;
}
