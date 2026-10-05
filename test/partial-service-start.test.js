import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
const file=process.env.PLUGIN_SOURCE || new URL('../src/adapters/openclaw/plugin.js', import.meta.url);
const source=fs.readFileSync(file,'utf8');
const block=source.slice(source.indexOf('    api.registerService({'),source.indexOf('    const localCollectorReady'));
function harness(failure) {
 const running=new Set(),timers=new Set();let service;
 const delivery=name=>({start(){running.add(name)},async stop(){running.delete(name)}});
 const scope={adapter:{},api:{runtime:{version:'2026.10.5'},registerService(s){service=s},logger:{warn(){}}},config:{enabled:true},auth:{load:async()=>{},canSend:()=>true,credential:()=>null},setupToken:null,stateDir:'/test',spool:null,uploader:null,runtimeDiagnostics:null,contextDelivery:null,usageDelivery:null,scheduleRunner:null,healthTimer:null,uploadTimer:null,
 openSpool:async()=>({cursor:()=>null,close:async()=>running.delete('spool')}),path:{join:(...p)=>p.join('/')},parseOpenClawActiveWorkCursor:()=>[],userTaskLifecycle:{restoreActiveWork(){}},HOOK_EVENT_SOURCE:'hooks',discoverOpenClawSources:async()=>({sources:[]}),createUploader:()=>({drain:async()=>{}}),createRuntimeDiagnosticsDelivery:()=>delivery('diagnostics'),createContextUsageDelivery:()=>delivery('context'),createUsageDelivery:()=>delivery('usage'),createScheduleRunner:()=>delivery('schedules'),diagnosticProbes:{dispose(){}},updates:{},collector:{start:async()=>{if(failure==='start')throw Error('transient-start')},stop:async()=>{}},emitHeartbeat:async()=>{if(failure==='heartbeat')throw Error('transient-heartbeat')},setInterval(fn){const t={fn};timers.add(t);return t},clearInterval(t){timers.delete(t)},runDetached(){},SpoolError:class extends Error{},recordSpoolFailure(){},VERSION:'0.2.33',persistActiveWork:async()=>{},collectOpenClawContext(){},collectOpenClawUsage(){}};
 new Function('scope','with(scope){'+block+'}')(scope);
 return {service,running,timers,scope};
}
for(const failure of ['start','heartbeat'])test('partial start '+failure+' must not leave side deliveries alive without heartbeat timer',async()=>{
 const h=harness(failure);await assert.rejects(h.service.start({logger:{info(){},error(){}}}),new RegExp('transient-'+failure));
 assert.deepEqual([...h.running],[],'orphaned side deliveries');assert.equal(h.timers.size,0,'orphaned upload timer');
});

for(const failure of ['start','heartbeat'])test('clean restart after '+failure+' creates exactly one timer pair',async()=>{
 const h=harness(failure);
 await assert.rejects(h.service.start({logger:{info(){},error(){}}}),new RegExp('transient-'+failure));
 assert.equal(h.scope.spool,null);assert.equal(h.scope.uploader,null);
 h.scope.collector.start=async()=>{};h.scope.emitHeartbeat=async()=>{};
 await h.service.start({logger:{info(){},error(){}}});
 assert.equal(h.timers.size,2);
 assert.deepEqual([...h.running].sort(),['context','diagnostics','schedules','usage']);
 await h.service.stop();assert.equal(h.timers.size,0);assert.deepEqual([...h.running],[]);
 await h.service.stop();assert.equal(h.timers.size,0);
});
test('authorization failure is propagated unchanged after cleanup, never healthy',async()=>{
 const h=harness(null),denied=Object.assign(Error('credential-rejected'),{status:401});
 h.scope.emitHeartbeat=async()=>{throw denied};
 await assert.rejects(h.service.start({logger:{info(){},error(){}}}),e=>e===denied);
 assert.equal(h.timers.size,0);assert.deepEqual([...h.running],[]);
});
