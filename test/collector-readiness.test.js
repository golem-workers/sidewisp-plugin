import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectorStateId, createCollectorReadiness } from '../src/adapters/openclaw/collector-readiness.js';
import { createConnectTool } from '../src/adapters/openclaw/connect-tool.js';

test('cold tool uses serving collector, preserving host binding and actual readiness', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-ready-'));
  const endpoint = 'https://example.test';
  try {
    const good = { plugin:'sidewisp', endpoint, enabled:true, running:true,
      connectionReadiness:{ready:true,stateId:await collectorStateId(stateDir)} };
    let status = good, begins = 0;
    const ready = createCollectorReadiness({enabled:true,endpoint,stateDir,
      localReady:async()=>false,readGatewayStatus:async()=>status});
    const tool = createConnectTool({endpoint,stateDir,ready,fetchImpl:async()=>{
      begins++; return {ok:true,json:async()=>({id:'sw_pair_'+'x'.repeat(32),userCode:'12345ABCDE',expiresAtMs:Date.now()+60000})};
    }});
    assert.equal((await tool.execute('cold',{requestId:'sw_pair_'+'x'.repeat(32),endpoint})).details.status,'approval_pending');
    assert.equal(begins,1);
    for (const bad of [null, {...good,plugin:'other'}, {...good,endpoint:'https://other.test'},
      {...good,enabled:false},{...good,running:false},{...good,connectionReadiness:undefined},
      {...good,connectionReadiness:{ready:false,stateId:good.connectionReadiness.stateId}},
      {...good,connectionReadiness:{ready:true,stateId:'another-store'}}]) {
      status=bad;
      assert.equal((await tool.execute('blocked',{requestId:'sw_pair_'+'x'.repeat(32),endpoint})).details.reason,'collector_not_ready');
    }
    assert.equal(begins,1);
  } finally {await fs.rm(stateDir,{recursive:true,force:true});}
});

test('disabled collector is not activated; unavailable/denied status fails closed without secrets',async()=>{
  const options={endpoint:'https://example.test',stateDir:'/tmp',localReady:async()=>false,
    readGatewayStatus:async()=>{throw Error('denied secret');}};
  assert.equal(await createCollectorReadiness({...options,enabled:false})(),false);
  const ready=createCollectorReadiness({...options,enabled:true});
  const result=await createConnectTool({...options,ready}).execute('denied',{
    requestId:'sw_pair_'+'x'.repeat(32),endpoint:options.endpoint});
  assert.equal(result.details.reason,'collector_status_unavailable');
  assert.doesNotMatch(JSON.stringify(result),/denied secret/);
});
