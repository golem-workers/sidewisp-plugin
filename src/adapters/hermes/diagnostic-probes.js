import os from 'node:os';
import {statfs} from 'node:fs/promises';
const fact=(key,value,unit)=>({key,value,status:'ok',severity:'info',...(unit?{unit}:{}),source:'host-probe'});
// The sidecar is not the Hermes process. Never report its heap/RSS as Hermes RAM.
export function createHermesDiagnosticProbes({stateDir,statfsImpl=statfs,totalmem=os.totalmem,freemem=os.freemem,uploader=()=>null,now=Date.now}={}){
 return {
  runtime:async()=>({outcome:'ok',facts:[fact('host.ram_total_bytes',totalmem(),'bytes'),fact('host.ram_free_bytes',freemem(),'bytes')]}),
  storage:async()=>{const s=await statfsImpl(stateDir);return {outcome:'ok',facts:s.blocks>0?[fact('disk.used_percent',Math.round((s.blocks-s.bavail)/s.blocks*1000)/10,'percent'),fact('disk.available_bytes',s.bavail*s.bsize,'bytes')]:[]}},
  connectivity:async()=>{const status=uploader();if(!status)return {outcome:'unsupported',facts:[]};const delivered=Date.parse(status.lastDeliveredAt??'');const fresh=Number.isFinite(delivered)&&now()>=delivered&&now()-delivered<900000&&['idle','sent'].includes(status.status);const allowed=new Set(['sent','retry','backpressure','rejected','dead-lettered']);return {outcome:'ok',facts:[fact('sidewisp.delivery_state',fresh?'sent':status.status==='credential-rejected'?'auth_rejected':allowed.has(status.status)?status.status:'unknown')]};},
 };
}
