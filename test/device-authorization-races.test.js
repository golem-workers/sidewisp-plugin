import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceAuthorizationClient } from '../src/auth/device-authorization.js';
import { createFileCredentialStore, createEnrollmentManager } from '../src/auth/credentials.js';
import { synchronizeCollectorAuthorization } from '../src/auth/collector-authorization.js';

for (const acknowledgement of ['denied', 'completed', 'expired', 'pending']) {
  test('credential retrieval / ACK race: '+acknowledgement, async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-ack-race-'));
    const id = 'sw_pair_'+'a'.repeat(32);
    const installationId = 'sw_ins_new12345678';
    let active = true;
    const store = createFileCredentialStore({ stateDir });
    const fetchImpl = async (url, options) => {
      if (url.pathname.endsWith('/credential-status')) return {status: active ? 200 : 401, json:async()=>({schema:'sidewisp.credential-status.v1',status:active?'active':'rejected',installationId})};
      const input = JSON.parse(options.body);
      if (url.pathname.endsWith('/begin')) return {ok:true,json:async()=>({id,userCode:'ABCDE12345'})};
      if (input.acknowledge) {
        assert.equal((await store.read()).installationId,installationId);
        if (acknowledgement === 'denied') active=false;
        return {ok:true,json:async()=>({status:acknowledgement})};
      }
      return {ok:true,json:async()=>({status:'approved',credential:{installationId,installationSecret:'sw_secret_'+'n'.repeat(43)}})};
    };
    try {
      const client=createDeviceAuthorizationClient({endpoint:'https://example.test',stateDir,fetchImpl});
      await client.begin({id,runtime:'openclaw'});
      if (acknowledgement === 'pending') {
        await assert.rejects(client.poll(),/invalid_device_ack/);
        await fs.stat(path.join(stateDir,'sidewisp/device-authorization.json'));
      } else {
        const result=await client.poll();
        assert.equal(result.status,acknowledgement==='denied'?'denied':'credential_saved');
        assert.equal(JSON.stringify(result).includes('sw_secret_'),false);
        const auth=createEnrollmentManager({endpoint:'https://example.test',store,fetchImpl});
        await synchronizeCollectorAuthorization({device:client,auth});
        assert.equal(auth.canSend(),acknowledgement!=='denied');
        await assert.rejects(fs.stat(path.join(stateDir,'sidewisp/device-authorization.json')),{code:'ENOENT'});
      }
    } finally { await fs.rm(stateDir,{recursive:true,force:true}); }
  });
}
