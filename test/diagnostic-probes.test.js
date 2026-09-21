import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawDiagnosticProbes } from '../src/adapters/openclaw/diagnostic-probes.js';
import { collectRuntimeDiagnostics } from '../src/core/diagnostics.js';
const input = { installationId: 'sw_ins_test12345', runtimeKind: 'openclaw', runtimeVersion: '2026.9.4', adapterName: 'sidewisp.openclaw', adapterVersion: '0.1.0' };
test('seven sections carry bounded observations, not names or secrets', async () => {
 const probes = createOpenClawDiagnosticProbes({stateDir:'/private/never-export', enrollment:()=>true,
  configuration:()=>({plugins:{entries:{SECRET_CHANNEL_NAME:{enabled:true}}}, password:'SECRET_VALUE'}),
  spool:()=>({status:'healthy',bytes:100,maxBytes:1000,recoveredFromCorruption:false}),
  uploader:()=>({status:'credential-rejected',remaining:2,at:'2026-01-01T00:00:00Z',transportCode:'SECRET_VALUE'}),
  updates:()=>({lastAttempt:{status:'rolled_back',updatedAt:'2026-01-01T00:00:00Z',reasonCode:'SECRET_VALUE'}}),
  statfsImpl:async()=>({blocks:100,bavail:6,bsize:4096,files:100,ffree:40}),statImpl:async()=>({size:100}),
  readFileImpl:async p=>p==='/proc/meminfo'?'MemTotal: 100 kB\nMemAvailable: 4 kB\nSwapTotal: 10 kB\nSwapFree: 1 kB\n':JSON.stringify({jobs:[{enabled:true,name:'SECRET_NAME',state:{lastStatus:'error'}}]})});
 const snapshot=await collectRuntimeDiagnostics({...input,probes});
 assert.equal(snapshot.sections.length,7);assert.ok(snapshot.sections.every(s=>s.facts.length));
 const serialized=JSON.stringify(snapshot); assert.doesNotMatch(serialized,/SECRET|private\/|password|credential-rejected/);
 assert.match(serialized,/auth_rejected/); assert.match(serialized,/rolled_back/); assert.match(serialized,/94/);
});
test('unavailable cron and malformed storage remain unknown, never healthy', async()=>{
 const probes=createOpenClawDiagnosticProbes({stateDir:'/unused',statImpl:async()=>{throw Object.assign(new Error('private'),{code:'ENOENT'})},statfsImpl:async()=>{throw new Error('private')}});
 const snapshot=await collectRuntimeDiagnostics({...input,probes});
 assert.equal(snapshot.sections.find(s=>s.key==='scheduler').outcome,'unsupported');
 assert.equal(snapshot.sections.find(s=>s.key==='storage').outcome,'error');assert.doesNotMatch(JSON.stringify(snapshot),/private/);
});
test('probe registration passes real diagnostics providers', async()=>{
 const {readFile}=await import('node:fs/promises');const text=await readFile(new URL('../src/adapters/openclaw/plugin.js',import.meta.url),'utf8');
 assert.match(text,/diagnosticProbes: createOpenClawDiagnosticProbes/);
});
