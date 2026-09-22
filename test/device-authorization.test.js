import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAuthorizationClient } from '../src/auth/device-authorization.js';

test('public handoff has no device proof; approval saves credential before ACK and removes request', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-device-test-'));
  const id = 'sw_pair_' + 'a'.repeat(32);
  let phase = 'pending'; let proof;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error');
    const input = JSON.parse(options.body);
    if (proof) assert.equal(input.deviceSecret, proof); else proof = input.deviceSecret;
    if (url.pathname.endsWith('/begin')) return { ok: true, json: async () => ({ id, userCode: '12345ABCDE', expiresAtMs: Date.now()+60000 }) };
    if (input.acknowledge) {
      const credential = JSON.parse(await fs.readFile(path.join(stateDir, 'sidewisp/installation.json'), 'utf8'));
      assert.equal(credential.status, 'active'); return { ok: true, json: async () => ({ status: 'completed' }) };
    }
    return { ok: true, json: async () => phase === 'pending' ? { status: phase } : { status: 'approved', credential: { installationId: 'sw_ins_abcdefgh12345678', installationSecret: 'sw_secret_'+'b'.repeat(43) } } };
  };
  try {
    const client = createDeviceAuthorizationClient({ endpoint: 'https://example.com', stateDir, fetchImpl });
    const publicResult = await client.begin({ id, runtime: 'hermes' });
    assert.equal(JSON.stringify(publicResult).includes(proof), false);
    assert.equal((await fs.stat(path.join(stateDir,'sidewisp/device-authorization.json'))).mode & 0o777, 0o600);
    assert.equal((await client.poll()).status, 'pending');
    phase = 'approved'; assert.equal((await client.poll()).status, 'credential_saved');
    await assert.rejects(fs.stat(path.join(stateDir,'sidewisp/device-authorization.json')), { code:'ENOENT' });
    await assert.rejects(client.begin({ id, runtime: 'hermes' }), /already_connected/);
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
});
test('device client rejects insecure endpoints', () => {
  for (const endpoint of ['http://example.com','https://user:pass@example.com','https://example.com/?secret=a']) {
    assert.throws(() => createDeviceAuthorizationClient({ endpoint, stateDir:'/tmp/example' }), /invalid_device_endpoint/);
  }
});
