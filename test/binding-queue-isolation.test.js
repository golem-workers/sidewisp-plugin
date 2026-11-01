import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSpool } from '../src/delivery/spool.js';
import { createUploader } from '../src/delivery/uploader.js';

const current = 'sw_ins_current123', old = 'sw_ins_deleted123';
async function fixture(t) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-binding-queue-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 return path.join(root, 'spool.sqlite');
}
function event(eventId, installationId, type='turn.completed') { return { eventId, installationId, type }; }
function uploader(spool, acknowledged=()=>{}) { return createUploader({spool, maxBatch:1, compressThresholdBytes:Infinity,
 endpoint:'https://example.test', credentialProvider:{current:async()=>({installationId:current,status:'active',secret:'local-test-secret'})},
 onAcknowledged:acknowledged, fetchImpl:async(_url, init)=>{
  const events=JSON.parse(init.body).events; assert.ok(events.every(e=>e.installationId===current));
  return {ok:true,status:200,json:async()=>({acknowledgedEventIds:events.map(e=>e.eventId)})};
 }}); }

test('73,000 old events are preserved outside live quota before the first new heartbeat, with no batch/timer drain', async t=>{
 const file=await fixture(t);let spool=await openSpool({file,maxBytes:128*1024*1024});
 spool.enqueueSourceBatch('recovery-cursor','73000',Array.from({length:73000},(_,n)=>event('old-'+n,old)));
 spool.coalesceRuntimeDiagnostic({installationId:old,snapshotId:'old-diagnostics'});
 spool.coalesceUsageBatch(old,'old-usage',{installationId:old,usage:123});
 await spool.close();
 // A previous full queue must not prevent persisting the first signal.
 spool=await openSpool({file,maxBytes:1024*1024,installationId:current});
 try {
  assert.equal(spool.cursor('recovery-cursor'),'73000');
  assert.equal(spool.pending().length,0);assert.ok(spool.health().bytes<1024*1024);
  spool.enqueueSourceBatch('health','1',[event('fresh-health',current,'health.snapshot')]);
  const accepted=[];assert.equal((await uploader(spool,events=>accepted.push(...events)).sendOnce()).sent,1);
  assert.deepEqual(accepted.map(e=>e.eventId),['fresh-health']);
  assert.equal(spool.quarantineOtherInstallations(current),0);
 } finally { await spool.close(); }
 const archive=new DatabaseSync(file+'.quarantine.sqlite',{readOnly:true});
 assert.equal(archive.prepare('SELECT count(*) AS n FROM quarantined').get().n,73002);
 const saved=JSON.parse(archive.prepare("SELECT payload FROM quarantined WHERE kind='event' AND item_id='old-72999'").get().payload);
 assert.equal(JSON.parse(saved.payload).installationId,old);assert.equal(saved.cursor,'73000');
 archive.close();assert.equal((await fs.stat(file+'.quarantine.sqlite')).mode&0o777,0o600);
});

test('helper-owned reapproval on a running queue isolates old events; healthy binding, cursors and usage stay intact',async t=>{
 const file=await fixture(t), spool=await openSpool({file});
 try {
  spool.enqueueSourceBatch('hook','stable-cursor',[event('old',old),event('activity',current),event('health',current,'health.snapshot')]);
  spool.coalesceRuntimeDiagnostic({installationId:current,snapshotId:'current-diag'});
  spool.coalesceUsageBatch(current,'current-usage',{usage:12});
  assert.equal((await uploader(spool).sendOnce()).sent,1);
  assert.deepEqual(spool.pending().map(x=>x.eventId),['activity']);
  assert.equal(spool.pendingRuntimeDiagnostic(current).snapshotId,'current-diag');
  assert.equal(spool.pendingUsageBatch(current).batchId,'current-usage');
  assert.equal(spool.cursor('hook'),'stable-cursor');
  assert.equal(spool.quarantineOtherInstallations(current),0);
 } finally { await spool.close(); }
});

test('archive failure leaves every old payload pending and does not send under replacement credentials',async t=>{
 const file=await fixture(t), spool=await openSpool({file});
 try {
  spool.enqueueSourceBatch('hook','2',[event('old',old),event('fresh',current)]);
  await fs.mkdir(file+'.quarantine.sqlite');
  await assert.rejects(uploader(spool).sendOnce());
  assert.deepEqual(spool.pending().map(x=>x.eventId).sort(),['fresh','old']);
 } finally { await spool.close(); }
});

test('same-binding backlog yields to newest health once, then preserves lifecycle order across restart',async t=>{
 const file=await fixture(t);let clock=1,spool=await openSpool({file,now:()=>clock});
 spool.enqueueSourceBatch('hook','1',[event('started',current)]);
 clock=2;spool.enqueueSourceBatch('hook','2',[event('completed',current)]);
 clock=3;spool.enqueueSourceBatch('health','3',[event('older-health',current,'health.snapshot')]);
 clock=4;spool.enqueueSourceBatch('health','4',[event('newest-health',current,'health.snapshot')]);
 await spool.close();spool=await openSpool({file,installationId:current});
 try {
  const sent=[],delivery=uploader(spool,events=>sent.push(...events.map(e=>e.eventId)));
  await delivery.sendOnce();await delivery.sendOnce();await delivery.sendOnce();
  assert.deepEqual(sent,['newest-health','started','completed']);
  assert.deepEqual(spool.pending().map(x=>x.eventId),['older-health']);
 } finally { await spool.close(); }
});
