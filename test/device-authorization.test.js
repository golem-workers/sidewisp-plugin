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
    if (url.pathname.endsWith('/credential-status')) return { status: 200, json: async () => ({ schema: 'sidewisp.credential-status.v1', status: 'active', installationId: 'sw_ins_abcdefgh12345678' }) };
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

test('rejected old binding can reconnect only after approval; outages and healthy bindings preserve credentials', async () => {
  for (const runtime of ['openclaw', 'hermes']) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-reconnect-'));
    const file = path.join(stateDir, 'sidewisp/installation.json');
    const old = { installationId: 'sw_ins_old12345678', secret: 'sw_secret_'+'o'.repeat(43), status: 'active' };
    await fs.mkdir(path.dirname(file)); await fs.writeFile(file, JSON.stringify(old));
    let status = 'active'; let approved = false; let beginCalls = 0;
    const id = 'sw_pair_'+'z'.repeat(32);
    const fetchImpl = async (url) => {
      if (url.pathname.endsWith('/credential-status')) {
        if (status === 'offline') throw new Error('network_down');
        if (status === 'server-error') return {status:503,json:async()=>({error:'unavailable'})};
        return { status: status === 'active' ? 200 : 401, json: async () => ({schema:'sidewisp.credential-status.v1',status,installationId:old.installationId}) };
      }
      if (url.pathname.endsWith('/begin')) { beginCalls++; return {ok:true,json:async()=>({id,userCode:'ABCDE12345'})}; }
      return {ok:true,json:async()=> approved ? {status:'approved',credential:{installationId:'sw_ins_new12345678',installationSecret:'sw_secret_'+'n'.repeat(43)}} : {status:'pending'}};
    };
    try {
      const client = createDeviceAuthorizationClient({endpoint:'https://example.com',stateDir,fetchImpl});
      for (status of ['active','offline','server-error']) {
        await assert.rejects(client.begin({id,runtime}));
        assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),old);
      }
      assert.equal(beginCalls,0);
      status='rejected'; assert.equal((await client.begin({id,runtime})).status,'pending');
      assert.equal((await client.poll()).status,'pending');
      assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),old);
      approved=true; status='active'; await assert.rejects(client.poll(),/already_connected/);
      status='rejected'; assert.equal((await client.poll()).status,'credential_saved');
      assert.equal(JSON.parse(await fs.readFile(file,'utf8')).installationId,'sw_ins_new12345678');
    } finally { await fs.rm(stateDir,{recursive:true,force:true}); }
  }
});
