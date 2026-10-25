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

test('new invitation can report a failure despite unrelated invalid authorization state without repairing it', async t => {
  for (const stale of ['{broken', 'null', JSON.stringify({id:'sw_pair_'+'o'.repeat(32),endpoint:'https://other.example',deviceSecret:'sw_device_'+'o'.repeat(43)})]) {
    const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-report-stale-'));
    t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
    const file=path.join(stateDir,'sidewisp/device-authorization.json');
    await fs.mkdir(path.dirname(file));await fs.writeFile(file,stale,{mode:0o600});
    const id='sw_pair_'+'n'.repeat(32), sent=[];
    const client=createDeviceAuthorizationClient({endpoint:'https://example.com',stateDir,fetchImpl:async(url,options)=>{
      assert.equal(url.pathname,'/v1/device-authorizations/preparation');
      sent.push(JSON.parse(options.body));return Response.json({});
    }});
    await client.reportPreparation({id,stage:'inspecting'});
    await client.reportPreparation({id,stage:'blocked',reasonCode:'preparation_failed'});
    assert.deepEqual(sent.map(row=>row.stage),['inspecting','blocked']);
    assert.equal(sent[0].id,id);assert.equal(sent[0].deviceSecret,sent[1].deviceSecret);
    assert.equal(await fs.readFile(file,'utf8'),stale);
    await assert.rejects(client.begin({id,runtime:'openclaw'}));
    assert.equal(sent.length,2);
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
    const fetchImpl = async (url, options) => {
      if (url.pathname.endsWith('/credential-status')) {
        if (status === 'offline') throw new Error('network_down');
        if (status === 'server-error') return {status:503,json:async()=>({error:'unavailable'})};
        return { status: status === 'active' ? 200 : 401, json: async () => ({schema:'sidewisp.credential-status.v1',status,installationId:old.installationId}) };
      }
      if (url.pathname.endsWith('/begin')) { beginCalls++; return {ok:true,json:async()=>({id,userCode:'ABCDE12345'})}; }
      if (JSON.parse(options.body).acknowledge) return {ok:true,json:async()=>({status:'completed'})};
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


test('reporting a separate failed invitation preserves an earlier preparation proof and imports legacy proofs',async t=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-prep-proofs-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const endpoint='https://example.com',oldId='sw_pair_'+'i'.repeat(32),newId='sw_pair_'+'j'.repeat(32),legacy=path.join(stateDir,'sidewisp/prepare-authorization.json');
 await fs.mkdir(path.dirname(legacy));const bytes=JSON.stringify({id:oldId,runtime:'openclaw',endpoint,deviceSecret:'sw_device_'+'l'.repeat(43)});await fs.writeFile(legacy,bytes,{mode:0o600});
 const proofs=new Map();const fetchImpl=async(url,options)=>{const body=JSON.parse(options.body);if(url.pathname.endsWith('/preparation'))proofs.set(body.id,body.deviceSecret);else {assert.equal(body.deviceSecret,proofs.get(body.id));return Response.json({id:body.id,userCode:'12345ABCDE'});}return Response.json({});};
 const client=createDeviceAuthorizationClient({endpoint,stateDir,fetchImpl});await client.reportPreparation({id:newId,stage:'blocked',reasonCode:'preparation_failed'});
 assert.equal(await fs.readFile(legacy,'utf8'),bytes);await client.reportPreparation({id:oldId,stage:'inspecting'});assert.equal(proofs.get(oldId),JSON.parse(bytes).deviceSecret);assert.notEqual(proofs.get(oldId),proofs.get(newId));
 await client.begin({id:oldId,runtime:'openclaw'});await assert.rejects(fs.stat(legacy),{code:'ENOENT'});
 assert.equal(JSON.parse(await fs.readFile(path.join(stateDir,'sidewisp/prepare-authorizations',newId+'.json'),'utf8')).deviceSecret,proofs.get(newId));
});
