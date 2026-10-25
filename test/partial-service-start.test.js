import {retryableCollectorStartupFailure,collectorStartupRetryDelay} from '../src/core/startup-recovery.js';
import {createHeartbeatSupervisor,permanentHeartbeatFailure} from '../src/core/heartbeat-supervisor.js';
import fs from 'node:fs';
import {createUploadPump} from '../src/delivery/upload-pump.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const file=process.env.PLUGIN_SOURCE || new URL('../src/adapters/openclaw/plugin.js', import.meta.url);
const source=fs.readFileSync(file,'utf8');
const block=source.slice(source.indexOf('    api.registerService({'),source.indexOf('    const localCollectorReady'));
function harness(failure) {
 const running=new Set(),timers=new Set();let service;
 const delivery=name=>({start(){running.add(name)},async stop(){running.delete(name)}});
 const scope={failedCollectorStart:false,restartCollector:null,collectorStarting:null,startupRetry:null,serviceStopping:false,startupFailures:0,retryableCollectorStartupFailure,collectorStartupRetryDelay,spoolFailure:null,questions:{dispose(){}},activation:{required:()=>false,serviceStarted(){}},createHeartbeatSupervisor,permanentHeartbeatFailure,adapter:{},api:{runtime:{version:'2026.10.5'},registerService(s){service=s},logger:{warn(){}}},config:{enabled:true,endpoint:'https://example.test'},auth:{load:async()=>{},canSend:()=>true,credential:()=>null},setupToken:null,stateDir:'/test',spool:null,uploader:null,runtimeDiagnostics:null,contextDelivery:null,cronDelivery:null,usageDelivery:null,scheduleRunner:null,healthTimer:null,uploadTimer:null,uploadPump:null,authorizationWatch:null,connectionNotifier:{stop:async()=>{},acknowledged(){}},createUploadPump,watch:()=>({on(){},unref(){},close(){}}),
 openSpool:async()=>({cursor:()=>null,close:async()=>running.delete('spool')}),path:{join:(...p)=>p.join('/')},parseOpenClawActiveWorkCursor:()=>[],userTaskLifecycle:{restoreActiveWork(){}},HOOK_EVENT_SOURCE:'hooks',discoverOpenClawSources:async()=>({sources:[]}),createUploader:()=>({drain:async()=>{}}),createRuntimeDiagnosticsDelivery:()=>delivery('diagnostics'),createContextUsageDelivery:()=>delivery('context'),createCronDelivery:()=>delivery('cron'),collectOpenClawCron(){},watchOpenClawCron(){},createUsageDelivery:()=>delivery('usage'),createScheduleRunner:()=>delivery('schedules'),diagnosticProbes:{dispose(){}},updates:{},collector:{start:async()=>{if(failure==='start')throw Error('transient-start')},stop:async()=>{}},emitHeartbeat:async()=>{if(failure==='heartbeat')throw Error('transient-heartbeat')},setInterval(fn){const t={fn};timers.add(t);return t},clearInterval(t){timers.delete(t)},runDetached(){},SpoolError:class extends Error{},recordSpoolFailure(){},VERSION:'0.2.33',persistActiveWork:async()=>{},collectOpenClawContext(){},collectOpenClawUsage(){}};
 new Function('scope','with(scope){'+block+'}')(scope);
 return {service,running,timers,scope};
}
for(const failure of ['start'])test('partial start '+failure+' must not leave side deliveries alive without heartbeat timer',async()=>{
 const h=harness(failure);await assert.rejects(h.service.start({logger:{info(){},error(){}}}),new RegExp('transient-'+failure));
 assert.deepEqual([...h.running],[],'orphaned side deliveries');assert.equal(h.timers.size,0,'orphaned upload timer');
});

for(const failure of ['start'])test('clean restart after '+failure+' creates exactly one timer pair',async()=>{
 const h=harness(failure);
 await assert.rejects(h.service.start({logger:{info(){},error(){}}}),new RegExp('transient-'+failure));
 assert.equal(h.scope.spool,null);assert.equal(h.scope.uploader,null);
 h.scope.collector.start=async()=>{};h.scope.emitHeartbeat=async()=>{};
 await h.service.start({logger:{info(){},error(){}}});
 assert.equal(h.timers.size,1);
 assert.deepEqual([...h.running].sort(),['context','cron','diagnostics','schedules','usage']);
 await h.service.stop();assert.equal(h.timers.size,0);assert.deepEqual([...h.running],[]);
 await h.service.stop();assert.equal(h.timers.size,0);
});
test('initial heartbeat failure stays supervised and stop cancels recovery',async()=>{
 const h=harness('heartbeat');await h.service.start({logger:{info(){},error(){}}});
 await new Promise(r=>setImmediate(r));assert.equal(h.scope.healthTimer.status().state,'recovering');assert.equal(h.scope.healthTimer.ready(),false);
 await h.service.stop();assert.equal(h.timers.size,0);assert.deepEqual([...h.running],[]);
});

test('actual registered service recovers one initial heartbeat failure without another start',async()=>{
 const h=harness(null);let attempts=0;
 h.scope.createHeartbeatSupervisor=options=>createHeartbeatSupervisor({...options,retryMs:5,intervalMs:1000});
 h.scope.emitHeartbeat=async()=>{if(++attempts===1)throw Error('temporary-snapshot-failure')};
 await h.service.start({logger:{info(){},error(){}}});
 await new Promise(r=>setTimeout(r,30));
 assert.equal(attempts,2);assert.equal(h.scope.healthTimer.ready(),true);assert.equal(h.timers.size,1);
 await h.service.stop();assert.equal(h.timers.size,0);
});
test('actual registered service does not retry explicit permission rejection',async()=>{
 const h=harness(null);let attempts=0;
 h.scope.createHeartbeatSupervisor=options=>createHeartbeatSupervisor({...options,retryMs:5});
 h.scope.emitHeartbeat=async()=>{attempts++;throw Object.assign(Error('permission denied'),{status:403})};
 await h.service.start({logger:{info(){},error(){}}});await new Promise(r=>setTimeout(r,20));
 assert.equal(attempts,1);assert.equal(h.scope.healthTimer.status().state,'blocked');assert.equal(h.scope.healthTimer.ready(),false);
 await h.service.stop();
});

test('affected hot generation does not poll or launch scheduled work before cold activation',async()=>{
 const h=harness(null);h.scope.activation.required=()=>true;let allowed;
 h.scope.createScheduleRunner=options=>{allowed=options.canExecute;return {start(){h.running.add('schedules')},stop:async()=>h.running.delete('schedules')}};
 await h.service.start({logger:{info(){},error(){}}});assert.equal(allowed(),false);assert.ok(h.running.has('context'));
 h.scope.activation.required=()=>false;assert.equal(allowed(),true);
 await h.service.stop();assert.deepEqual([...h.running],[]);
});

test('a transient filesystem startup refusal recovers without another service start', async () => {
 const h=harness(null);let starts=0;
 h.scope.collectorStartupRetryDelay=()=>5;
 const open=h.scope.openSpool;
 h.scope.openSpool=async(...args)=>{if(++starts===1)throw Object.assign(Error('temporarily inaccessible'),{code:'EACCES'});return open(...args)};
 await h.service.start({logger:{info(){},error(){}}});
 assert.equal(h.scope.spool,null);assert.equal(h.timers.size,0);
 await new Promise(r=>setTimeout(r,30));
 assert.equal(starts,2);assert.equal(h.scope.healthTimer.ready(),true);assert.equal(h.timers.size,1);
 assert.deepEqual([...h.running].sort(),['context','cron','diagnostics','schedules','usage']);
 await h.service.stop();assert.equal(h.timers.size,0);assert.deepEqual([...h.running],[]);
});

test('a partial transient start is cleaned before autonomous retry, without duplicate deliveries',async()=>{
 const h=harness(null);let starts=0,maxLive=0;
 h.scope.collectorStartupRetryDelay=()=>5;
 h.scope.collector.start=async()=>{maxLive=Math.max(maxLive,h.running.size);if(++starts===1)throw Object.assign(Error('resource temporarily busy'),{code:'EBUSY'})};
 await h.service.start({logger:{info(){},error(){}}});assert.deepEqual([...h.running],[]);assert.equal(h.timers.size,0);
 await new Promise(r=>setTimeout(r,30));assert.equal(starts,2);assert.equal(maxLive,5);assert.equal(h.timers.size,1);
 await h.service.stop();assert.deepEqual([...h.running],[]);
});

test('explicit service stop cancels a scheduled startup retry',async()=>{
 const h=harness(null);let starts=0;
 h.scope.collectorStartupRetryDelay=()=>30;
 h.scope.openSpool=async()=>{starts++;throw Object.assign(Error('disk temporarily full'),{code:'ENOSPC'})};
 await h.service.start({logger:{info(){},error(){}}});await h.service.stop();
 await new Promise(r=>setTimeout(r,60));assert.equal(starts,1);assert.equal(h.scope.startupRetry,null);assert.equal(h.timers.size,0);
});

test('authorization refusal and unsupported state do not schedule automatic startup retries',async()=>{
 for(const code of ['CREDENTIAL_REJECTED','unsupported-schema','UNKNOWN_STARTUP_ERROR']){
  const h=harness(null);let starts=0;h.scope.openSpool=async()=>{starts++;throw Object.assign(Error(code),{code})};
  await assert.rejects(h.service.start({logger:{info(){},error(){}}}),new RegExp(code));
  assert.equal(starts,1);assert.equal(h.scope.startupRetry,null);assert.deepEqual([...h.running],[]);
 }
});

test('explicit authorization rejection wins over a generic OS-style error code',async()=>{
 const h=harness(null);h.scope.openSpool=async()=>{throw Object.assign(Error('forbidden'),{code:'EACCES',status:403})};
 await assert.rejects(h.service.start({logger:{info(){},error(){}}}),/forbidden/);assert.equal(h.scope.startupRetry,null);
});

test('same-context recovery after a non-retryable startup failure is single-flight',async()=>{
 const h=harness(null);let attempts=0;
 const open=h.scope.openSpool;h.scope.openSpool=async(...args)=>{if(++attempts===1)throw Object.assign(Error('injected transient liveness fault'),{code:'EFAULT'});await new Promise(r=>setImmediate(r));return open(...args);};
 await assert.rejects(h.service.start({logger:{info(){},error(){}}}),/injected/);
 await h.service.stop();assert.equal(h.scope.failedCollectorStart,true);
 await Promise.all([h.scope.restartCollector(),h.scope.restartCollector()]);
 await new Promise(r=>setImmediate(r));assert.equal(attempts,2);assert.equal(h.timers.size,1);assert.equal(h.scope.healthTimer.ready(),true);
 await h.service.stop();assert.equal(h.timers.size,0);
});
