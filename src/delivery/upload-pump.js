// Hooks only commit to disk and request a wake. Network work never holds a host hook.
export function createUploadPump({ upload, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, coalesceMs = 25 }) {
 let stopped=false, pending=false, timer=null, flight=null;
 const schedule=()=>{ if(stopped || timer!==null || flight || !pending)return;timer=setTimer(()=>{timer=null;void drain();},coalesceMs);timer?.unref?.(); };
 const drain=async()=>{if(stopped || flight || !pending)return;pending=false;
  flight=Promise.resolve().then(upload).then(result=>{
   // Continue a positively acknowledged backlog without waiting for a new hook.
   // No ACK (including an outage or a zero-progress response) uses the normal retry timer.
   if(result?.status==='backpressure' && result.sent>0 && result.remaining>0)pending=true;
  }).catch(error=>{try{onError(error);}catch{}});
  try{await flight;}finally{flight=null;schedule();}
 };
 return {request(){if(stopped)return;pending=true;schedule();},async stop(){stopped=true;pending=false;if(timer!==null)clearTimer(timer);timer=null;if(flight)await flight;}};
}
