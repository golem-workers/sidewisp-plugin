import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEnrollmentManager, createFileCredentialStore } from '../src/auth/credentials.js';
import { createDeviceAuthorizationClient } from '../src/auth/device-authorization.js';
import { synchronizeCollectorAuthorization } from '../src/auth/collector-authorization.js';

for (const reconnect of [false, true]) {
  test(`running collector adopts externally saved approval; reconnect=${reconnect}`, async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-adopt-'));
    const store = createFileCredentialStore({ stateDir });
    const credential = n => ({ installationId: `sw_ins_${n}12345678`, secret: 'sw_secret_' + n.repeat(43), status: 'active' });
    try {
      if (reconnect) await store.write(credential('old'));
      const auth = createEnrollmentManager({ endpoint: 'https://example.test', store });
      await auth.load();
      // Same atomic write used by the CLI. Its pending request has been ACKed and removed.
      await store.write(credential('new'));
      const device = createDeviceAuthorizationClient({ endpoint: 'https://example.test', stateDir,
        fetchImpl: () => { throw Error('no pending file: network must not be called'); } });
      await synchronizeCollectorAuthorization({ device, auth });
      assert.equal(auth.canSend(), true);
      assert.deepEqual(auth.credential(), credential('new'));
      await store.write({ ...credential('new'), status: 'revoked' });
      await synchronizeCollectorAuthorization({ device, auth });
      assert.equal(auth.canSend(), false);
    } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
  });
}

test('poll failure does not hide an already saved credential or disclose its error', async () => {
  const calls = [];
  await synchronizeCollectorAuthorization({
    device: { poll: async () => { throw Error('secret provider response'); } },
    auth: { load: async () => calls.push('load') },
    onPendingError: (...args) => { assert.deepEqual(args, []); calls.push('diagnostic'); },
  });
  assert.deepEqual(calls, ['diagnostic', 'load']);
});
