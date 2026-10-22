import crypto from 'node:crypto';
import { signBatch } from './uploader.js';

// Latest-only numeric telemetry. No full diagnostics, transcript reads or durable backlog.
export function createContextUsageDelivery({collect,credentialProvider,endpoint,fetchImpl=globalThis.fetch,
  now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=30000}) {
  let timer=null,running=null,stopped=true;
  let last={status:'not-started',at:null};
  const finish=status=>(last={status,at:new Date(now()).toISOString()});
  async function execute(){
    const credential=await credentialProvider.current();
    if(!credential || credential.status!=='active')return finish('disabled');
    try {
      const facts=await collect();const observedAtMs=now();const get=k=>facts.find(f=>f.key===k)?.value??null;
      const sample={schema:'sidewisp.context-usage.v1',installationId:credential.installationId,observedAtMs,
        used:get('context.used'),capacity:get('context.capacity'),measuredAtMs:get('context.measured_at_ms')};
      const body=Buffer.from(JSON.stringify(sample)),timestamp=Math.floor(observedAtMs/1000).toString(),nonce=crypto.randomBytes(16).toString('base64url');
      const signature=signBatch({secret:credential.secret,timestamp,nonce,body});
      const response=await fetchImpl(new URL('/v1/context-usage',endpoint),{method:'POST',body,signal:AbortSignal.timeout(10000),headers:{
        'content-type':'application/json',authorization:`Sidewisp ${credential.installationId}:${signature}`,
        'x-sidewisp-algorithm':'hmac-sha256-v1','x-sidewisp-timestamp':timestamp,'x-sidewisp-nonce':nonce}});
      if(!response.ok)return finish(response.status===401 || response.status===403?'credential-rejected':'retry');
      const ack=await response.json();
      return finish(ack.schema==='sidewisp.context-usage-ack.v1' && ack.observedAtMs===observedAtMs?'sent':'invalid-ack');
    }catch{return finish('retry');}
  }
  function run(){if(running)return running;running=execute().finally(()=>{running=null;});return running;}
  function tick(){if(stopped)return;const started=now();void run().finally(()=>{
    if(!stopped){timer=setTimer(tick,Math.max(0,intervalMs-(now()-started)));timer?.unref?.();}
  });}
  return Object.freeze({run,status:()=>({...last}),start(){if(!stopped)return;stopped=false;tick();},async stop(){stopped=true;if(timer)clearTimer(timer);timer=null;if(running)await running;}});
}
