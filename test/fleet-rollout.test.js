import test from 'node:test';
import assert from 'node:assert/strict';
import { planFleetRollout } from '../src/release/fleet-rollout.js';

const start = 1_000_000;
const release = { version: '0.2.34', commit: 'a'.repeat(40), sha256: 'b'.repeat(64),
  environments: ['staging'], verifiedMigrations: ['openclaw/0.2.33/2026.9.6'] };
const agent = (id, extra = {}) => ({ id, runtime: 'openclaw', runtimeVersion: '2026.9.6',
  version: '0.2.33', status: 'active', credentialActive: true, lastSeen: start, ...extra });
const plan = (agents, state, now = start) => planFleetRollout({ release, environment: 'staging', agents, state, now });

test('one canary per validated migration; offline, legacy, Hermes, revoked and deleted excluded', () => {
  const p = plan([agent('a'), agent('b'), agent('offline', { lastSeen: 0 }),
    agent('legacy', { version: '0.2.17' }), agent('hermes', { runtime: 'hermes' }),
    agent('revoked', { credentialActive: false }), agent('deleted', { status: 'deleted' })]);
  assert.deepEqual(p.policy.allowlist, ['a']);
  assert.equal(p.observations.length, 7);
  assert.equal(p.policy.rolloutPercent, 0);
});
test('version heartbeat or old terminal snapshot cannot promote; fresh correlated success can', () => {
  const p = plan([agent('a'), agent('b')]);
  const now = start + 130_000;
  const a = agent('a', { version: '0.2.34', lastSeen: now });
  const b = agent('b', { lastSeen: now });
  assert.deepEqual(plan([a, b], p.nextState, now).policy.allowlist, ['a']);
  a.update = { status: 'completed', observedAt: now, attemptAt: start - 1 };
  assert.deepEqual(plan([a, b], p.nextState, now).policy.allowlist, ['a']);
  a.update.attemptAt = start + 30_000;
  const promoted = plan([a, b], p.nextState, now);
  assert.deepEqual(promoted.policy.allowlist, ['b']);
  assert.equal(promoted.nextState.attempts.a.completed, true);
});
test('failure halts durably and withdraws directives, no automatic retry', () => {
  const p = plan([agent('a'), agent('b')]);
  const a = agent('a', { update: { status: 'failed', observedAt: start + 10, attemptAt: start + 1 } });
  const halted = plan([a, agent('b')], p.nextState, start + 20);
  assert.deepEqual(halted.policy.allowlist, []);
  assert.equal(halted.nextState.phase, 'halted');
  assert.deepEqual(plan([agent('a'), agent('b')], halted.nextState).policy.allowlist, []);
});
test('returning offline installation is considered after its cohort is proven', () => {
  const p = plan([agent('a'), agent('b', { lastSeen: 0 })]);
  const now = start + 130_000;
  const a = agent('a', { version: '0.2.34', lastSeen: now,
    update: { status: 'completed', observedAt: now, attemptAt: start + 1 } });
  const p2 = plan([a, agent('b', { lastSeen: 0 })], p.nextState, now);
  assert.deepEqual(p2.policy.allowlist, []);
  assert.deepEqual(plan([a, agent('b', { lastSeen: now })], p2.nextState, now).policy.allowlist, ['b']);
});
test('environment and release changes cannot silently reuse approval or state', () => {
  assert.throws(() => planFleetRollout({ release, environment: 'production', agents: [] }), /INVALID/);
  const p = plan([agent('a')]);
  assert.throws(() => planFleetRollout({ release: { ...release, commit: 'c'.repeat(40) },
    environment: 'staging', agents: [], state: p.nextState }), /RELEASE_CHANGE/);
});
test('revoked canary and timeouts halt instead of promoting', () => {
  const p = plan([agent('a'), agent('b')]);
  assert.equal(plan([agent('a', { credentialActive: false }), agent('b')], p.nextState).nextState.phase, 'halted');
  assert.equal(plan([agent('a'), agent('b')], p.nextState, start + 3_600_001).nextState.phase, 'halted');
});
