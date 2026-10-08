import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {signBatch} from '../delivery/uploader.js';
import {validManagedDirective} from './manager.js';

// A fresh signed request on each connection; no release/version polling.
export async function consumeUpdateEvents({endpoint,credential,report,onDirective,signal,fetchImpl=fetch,connectTimeoutMs=15000,idleTimeoutMs=90000}) {
 const url=new URL('/v1/installations/update-events',endpoint);
 if(url.protocol!=='https:'||url.username||url.password)throw Error('INVALID_ENDPOINT');
 const body=Buffer.from(JSON.stringify({schema:'sidewisp.update-heartbeat.v1',runtime:'openclaw',...report}));
 const timestamp=Math.floor(Date.now()/1000).toString(),nonce=randomBytes(16).toString('base64url');
 const signature=signBatch({secret:credential.secret,timestamp,nonce,body});
 const transport=new AbortController();let deadline=setTimeout(()=>transport.abort(),connectTimeoutMs);
 const reset=()=>{clearTimeout(deadline);deadline=setTimeout(()=>transport.abort(),idleTimeoutMs);};
 try{
 const response=await fetchImpl(url,{method:'POST',redirect:'error',body,signal:signal?AbortSignal.any([signal,transport.signal]):transport.signal,headers:{'content-type':'application/json',accept:'text/event-stream',authorization:`Sidewisp ${credential.installationId}:${signature}`,'x-sidewisp-algorithm':'hmac-sha256-v1','x-sidewisp-timestamp':timestamp,'x-sidewisp-nonce':nonce}});
 if(!response.ok)throw Error([401,403].includes(response.status)?'CREDENTIAL_REJECTED':'CONTROL_UNAVAILABLE');
 if(!response.headers.get('content-type')?.startsWith('text/event-stream')||!response.body)throw Error('INVALID_EVENT_STREAM');
 reset();
 let pending='',data=[],bytes=0;const decoder=new TextDecoder();
 for await(const chunk of response.body){
  reset();pending+=decoder.decode(chunk,{stream:true});
  if(pending.length>65536)throw Error('EVENT_FRAME_TOO_LARGE');
  let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).replace(/\r$/,'');pending=pending.slice(end+1);
   if(!line){if(data.length){const event=JSON.parse(data.join('\n'));
    if(event.schema!=='sidewisp.update-events.v1'||event.installationId!==credential.installationId||!(event.update===null||validManagedDirective(event.update)))throw Error('INVALID_CONTROL_RESPONSE');
    await onDirective(event.update);
   }data=[];bytes=0;
   }else if(line.startsWith('data:')){const part=line.slice(5).replace(/^ /,'');bytes+=part.length;if(bytes>65536)throw Error('EVENT_FRAME_TOO_LARGE');data.push(part);}
  }
 }
 if(!signal?.aborted)throw Error('CONTROL_DISCONNECTED');
 }finally{clearTimeout(deadline);transport.abort();}
}

export async function maintainUpdateEvents({connect,onError=()=>{},signal,sleep=delay}) {
 let failures=0;
 while(!signal.aborted){
  try{await connect(()=>{failures=0;});}catch(error){if(signal.aborted)break;onError(error);}
  if(signal.aborted)break;
  // Network recovery only: never fetch a version on a periodic timer.
  const wait=Math.min(30000,1000*2**Math.min(failures++,5));
  try{await sleep(wait,undefined,{signal});}catch(error){if(!signal.aborted)throw error;}
 }
}
