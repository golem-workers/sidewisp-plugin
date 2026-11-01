import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOpenClawCron } from '../src/cron/openclaw.js';
import { createCronDelivery } from '../src/delivery/cron.js';
const nativeJob = { id: 'native-job-1', name: 'Daily check', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Europe/Berlin' },
  payload: { kind: 'agentTurn', message: 'PRIVATE PROMPT bearer secret-value' }, delivery: { to: 'PRIVATE TARGET' }, state: { nextRunAtMs: 1800000000000, lastStatus: 'ok' } };
const collect = jobs => collectOpenClawCron({ stateDir: '/fake', statImpl: async () => ({ size: 100 }), readFileImpl: async () => JSON.stringify({ jobs }) });
test('native cron inventory is read-only and excludes prompt/command/target material', async () => {
  const result = await collect([nativeJob, { ...nativeJob, id: 'disabled', enabled: false, schedule: { kind: 'every', everyMs: 120000 } }, { ...nativeJob, id: 'once', schedule: { kind: 'at', at: '2026-12-01T00:00:00Z' } }]);
  assert.equal(result.status, 'ok'); assert.equal(result.jobs.length, 3);
  assert.equal(result.jobs.find(job => job.id === 'disabled').enabled, false);
  assert.equal(result.jobs.find(job => job.id === 'once').kind, 'at');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|bearer|secret-value|message|delivery/);
  assert.equal((await collect([{ ...nativeJob, name: 'token=PRIVATE' }])).jobs[0].displayName, 'Cron job');
});
test('missing, corrupt, oversized or incomplete inventories never claim zero active jobs', async () => {
  assert.deepEqual(await collect([]), { status: 'ok', jobs: [] });
  assert.equal((await collect([nativeJob, nativeJob])).status, 'unavailable');
  assert.equal((await collect([{ ...nativeJob, schedule: { kind: 'broken' } }])).status, 'unavailable');
  assert.equal((await collect(Array.from({ length: 1001 }, (_, index) => ({ ...nativeJob, id: String(index) })))).status, 'unavailable');
  assert.equal((await collectOpenClawCron({ stateDir: '/fake', statImpl: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } })).status, 'unsupported');
  assert.equal((await collectOpenClawCron({ stateDir: '/fake', statImpl: async () => ({ size: 3 * 1024 * 1024 }) })).status, 'unavailable');
});
test('delivery is signed, single-flight, acknowledgement-bound and disabled without credentials', async () => {
  const credential = { status: 'active', installationId: 'sw_ins_test12345', secret: 'test-only-secret' };
  let sends = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const delivery = createCronDelivery({ collect: () => collect([nativeJob]), credentialProvider: { current: async () => credential }, endpoint: 'http://localhost:1234', now: () => 1800000000000,
    fetchImpl: async (url, options) => { sends++; await wait; assert.equal(url.pathname, '/v1/cron/snapshots'); assert.match(options.headers.authorization, /^Sidewisp sw_ins_test12345:/); const sample = JSON.parse(options.body); assert.equal(sample.schema, 'sidewisp.cron-snapshot.v1'); return { ok: true, json: async () => ({ schema: 'sidewisp.cron-ack.v1', observedAtMs: sample.observedAtMs }) }; } });
  const first = delivery.run(); assert.equal(first, delivery.run()); release(); assert.equal((await first).status, 'sent'); assert.equal(sends, 1);
  const disabled = createCronDelivery({ collect: () => { throw new Error('must not collect'); }, credentialProvider: { current: async () => null }, endpoint: 'http://localhost' });
  assert.equal((await disabled.run()).status, 'disabled'); await delivery.stop();
  const wrongAck = createCronDelivery({ collect: () => collect([]), credentialProvider: { current: async () => credential }, endpoint: 'http://localhost', fetchImpl: async () => ({ ok: true, json: async () => ({ schema: 'wrong', observedAtMs: 1 }) }) });
  assert.equal((await wrongAck.run()).status, 'invalid-ack');
});

test('job-store changes refresh immediately, coalesce during upload, and unsubscribe on stop', async () => {
  let changed, unsubscribed = false, sends = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const delivery = createCronDelivery({ collect: () => collect([nativeJob]), credentialProvider: { current: async () => ({ status: 'active', installationId: 'sw_ins_test12345', secret: 'test-secret' }) }, endpoint: 'http://localhost',
    subscribe: callback => { changed = callback; return () => { unsubscribed = true; }; }, setTimer: () => ({ unref() {} }), clearTimer: () => {},
    fetchImpl: async (_url, options) => { sends++; if (sends === 1) await wait; const sample = JSON.parse(options.body); return { ok: true, json: async () => ({ schema: 'sidewisp.cron-ack.v1', observedAtMs: sample.observedAtMs }) }; } });
  delivery.start(); changed(); changed(); const pending = delivery.run(); release(); await pending;
  assert.equal(sends, 2); await delivery.stop(); assert.equal(unsubscribed, true); changed(); assert.equal(sends, 2);
});
