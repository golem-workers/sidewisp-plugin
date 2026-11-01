import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { classifyOpenClawCron } from '../src/cron/classification.js';
import { collectOpenClawCron } from '../src/cron/openclaw.js';
const version = '2026.9.8';
// Public internal token from the version-pinned bundled memory-core creator,
// not an authored task prompt. Production compares its digest locally.
const marker = '__openclaw_memory_core_short_term_promotion_dream__';
const base = { id: 'test-job', name: 'Renamed built-in', enabled: true,
  schedule: { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' }, sessionTarget: 'isolated', wakeMode: 'now',
  payload: { kind: 'agentTurn', message: 'AUTHORED_PRIVATE' }, delivery: { mode: 'none' }, state: {} };
const memory = { ...base, declarationKey: 'memory-core:memory-dreaming-promotion', payload: { kind: 'agentTurn', message: marker, lightContext: true } };
const heartbeat = { ...base, declarationKey: 'heartbeat:main', agentId: 'main', payload: { kind: 'heartbeat' } };
const skill = { ...base, declarationKey: 'skill-collection-review:main', agentId: 'main' };
const classify = job => classifyOpenClawCron(job, version).kind;
const collect = jobs => collectOpenClawCron({ stateDir: '/fake-cron-classification', runtimeVersion: version,
  sqliteStatImpl: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
  statImpl: async () => ({ size: 100 }), readFileImpl: async () => JSON.stringify({ jobs }) });

test('only three pinned families classify regardless of name or enabled; no input mutation', () => {
  for (const [job, kind] of [[memory, 'memory-dreaming'], [heartbeat, 'heartbeat-monitor'], [skill, 'skill-collection-review']]) {
    const before = JSON.stringify(job);
    for (const enabled of [true, false]) assert.deepEqual(classifyOpenClawCron({ ...job, name: 'Arbitrary rename', enabled }, version), { kind, ruleVersion: 1 });
    assert.equal(JSON.stringify(job), before);
    for (const v of [undefined, null, '2026.9.7', '2026.9.9', '2026.9.8-custom']) assert.equal(classifyOpenClawCron(job, v).kind, 'unknown');
  }
});
test('memory declaration alone, legacy token or conflicting canonical shape never hides authored work', () => {
  const conflicts = [
    { ...memory, declarationKey: undefined }, { ...memory, declarationKey: memory.declarationKey + ':other' },
    { ...memory, payload: { ...memory.payload, message: 'AUTHORED_PRIVATE' } },
    { ...memory, payload: { ...memory.payload, message: marker + ' authored suffix' } },
    { ...memory, payload: { ...memory.payload, message: ' ' + marker } },
    { ...memory, payload: { ...memory.payload, lightContext: false } },
    { ...memory, payload: { ...memory.payload, kind: 'systemEvent' } },
    { ...memory, sessionTarget: 'main' }, { ...memory, delivery: { mode: 'announce', to: 'PRIVATE_TARGET' } },
    { ...memory, schedule: { kind: 'every', everyMs: 120000 } }, { ...memory, wakeMode: 'next-heartbeat' },
  ];
  for (const job of conflicts) assert.equal(classify(job), 'unknown');
});
test('user/native/systemEvent/Doctor tasks, name matches and conflicting creators remain visible', () => {
  for (const job of [base, { ...base, name: 'Memory Dreaming Promotion' },
    { ...base, declarationKey: 'heartbeat-task:main:imported' }, { ...base, declarationKey: 'custom:main' },
    { ...base, payload: { kind: 'systemEvent', text: 'AUTHORED_PRIVATE' }, createdActor: { type: 'system' } },
    { ...heartbeat, payload: { kind: 'systemEvent' } }, { ...heartbeat, declarationKey: 'heartbeat:' },
    { ...skill, declarationKey: 'skill-collection-review:main:extra' },
    { ...heartbeat, agentId: 'other' }, { ...skill, owner: { agentId: 'other' } },
    ...[memory, heartbeat, skill].flatMap(job => ['human', 'agent', 'unrecognized'].map(type => ({ ...job, createdActor: { type } }))),
  ]) assert.equal(classify(job), 'unknown');
});
test('all at/every/cron and enabled states retain user inventory with only safe classification', async () => {
  const jobs = [true, false].flatMap(enabled => [
    { kind: 'cron', expr: '0 3 * * *', tz: 'UTC' }, { kind: 'every', everyMs: 120000 }, { kind: 'at', at: '2026-12-01T00:00:00Z' },
  ].map((schedule, i) => ({ ...base, id: `user-${enabled}-${i}`, enabled, schedule, declarationKey: 'custom:decl', owner: { sessionKey: 'PRIVATE_OWNER' }, delivery: { to: 'PRIVATE_TARGET' } })));
  const result = await collect(jobs);
  assert.equal(result.status, 'ok'); assert.equal(result.jobs.length, 6);
  assert.equal(result.jobs.filter(job => !job.enabled).length, 3);
  for (const job of result.jobs) assert.deepEqual(job.classification, { kind: 'unknown', ruleVersion: 1 });
  assert.doesNotMatch(JSON.stringify(result), /AUTHORED_PRIVATE|PRIVATE_OWNER|PRIVATE_TARGET|declarationKey|createdActor|message|delivery/);
});
test('classification does not remove inventory: all-built-in snapshot and unsupported schedule fail honestly', async () => {
  const result = await collect([memory, { ...heartbeat, id: 'h' }, { ...skill, id: 's' }]);
  assert.equal(result.jobs.length, 3); assert.ok(result.jobs.every(job => job.classification.kind !== 'unknown'));
  for (const kind of ['on-exit', 'stream']) {
    assert.deepEqual(await collect([{ ...memory, schedule: { kind } }, base]), { status: 'unavailable', jobs: [] });
  }
});
test('SQLite and JSON yield identical classification, do not change enabled/state/schedule or delivery', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'sw-classification-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  await mkdir(path.join(stateDir, 'cron')); await mkdir(path.join(stateDir, 'state'));
  const store = path.join(stateDir, 'cron', 'jobs.json');
  const jobs = [memory, { ...heartbeat, id: 'h', enabled: false }, { ...skill, id: 's' }, { ...base, id: 'u' }];
  await writeFile(store, JSON.stringify({ jobs }));
  const options = { stateDir, runtimeVersion: version };
  const json = await collectOpenClawCron(options), beforeJSON = await readFile(store);
  const db = new DatabaseSync(path.join(stateDir, 'state', 'openclaw.sqlite')); t.after(() => db.close());
  db.exec('CREATE TABLE cron_jobs (store_key TEXT, job_id TEXT, enabled INTEGER, job_json TEXT, state_json TEXT)');
  for (const job of jobs) db.prepare('INSERT INTO cron_jobs VALUES(?,?,?,?,?)').run(store, job.id, Number(job.enabled), JSON.stringify(job), JSON.stringify(job.state));
  const rows = () => db.prepare('SELECT * FROM cron_jobs ORDER BY job_id').all(); const beforeRows = rows();
  assert.deepEqual(await collectOpenClawCron(options), json);
  assert.deepEqual(rows(), beforeRows); assert.deepEqual(await readFile(store), beforeJSON);
});
