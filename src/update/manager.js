import {randomBytes} from 'node:crypto';
import {signBatch} from '../delivery/uploader.js';
import {validUpdateDirective,isNewerVersion} from './directive.js';
export function validManagedDirective(d) {return validUpdateDirective(d)&&/^[a-f0-9]{64}$/.test(d.sha256??'')&&/^[A-Za-z0-9_-]{1,80}$/.test(d.revision??'')&&d.mandatory===true;}
export async function updateHeartbeat({endpoint,credential,report,fetchImpl=fetch}) {
 const url=new URL('/v1/installations/update-heartbeat',endpoint);
 if(url.protocol!=='https:'||url.username||url.password)throw Error('INVALID_ENDPOINT');
 const body=Buffer.from(JSON.stringify({schema:'sidewisp.update-heartbeat.v1',runtime:'openclaw',...report}));
 const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(16).toString('base64url');
 const signature=signBatch({secret:credential.secret,timestamp,nonce,body});
 const response=await fetchImpl(url,{method:'POST',redirect:'error',body,signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',authorization:`Sidewisp ${credential.installationId}:${signature}`,'x-sidewisp-algorithm':'hmac-sha256-v1','x-sidewisp-timestamp':timestamp,'x-sidewisp-nonce':nonce}});
 if(!response.ok)throw Error([401,403].includes(response.status)?'CREDENTIAL_REJECTED':'CONTROL_UNAVAILABLE');
 const result=await response.json();
 if(result.schema!=='sidewisp.update-heartbeat.v1'||result.installationId!==credential.installationId||!(result.update===null||validManagedDirective(result.update)))throw Error('INVALID_CONTROL_RESPONSE');
 return result.update;
}
export function shouldApply({directive,currentVersion,attempt,active=false,currentReady=true}) {
 if(active||!validManagedDirective(directive))return false;
 if(currentVersion&&isNewerVersion(currentVersion,directive.targetVersion))return false;
 if(currentVersion===directive.targetVersion&&currentReady&&attempt?.mode!=='single_current')return false;
 // A fresh policy revision can authorize retry after a resolved failure, never
 // resume an interrupted mutation or rollback blindly.
 if(attempt?.mode!=='single_current'&&['updating','verifying','rolling_back'].includes(attempt?.status))return false;
 if(attempt?.targetVersion===directive.targetVersion && attempt?.revision===directive.revision && ['failed','rolled_back','completed','skipped'].includes(attempt.status))return false;
 return true;
}
