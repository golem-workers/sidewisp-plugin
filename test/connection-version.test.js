import test from 'node:test';
import assert from 'node:assert/strict';
import {versionAtLeast,createCollectorReadiness} from '../src/adapters/openclaw/collector-readiness.js';
test('strict version comparison rejects unknown and prerelease generations',()=>{
 assert.equal(versionAtLeast('0.2.39','0.2.39'),true);
 assert.equal(versionAtLeast('0.2.40','0.2.39'),true);
 for(const v of [undefined,'0.2.33','0.2.39-dev','garbage']) assert.equal(versionAtLeast(v,'0.2.39'),false);
});
test('ready local collector performs version preflight without model RPC',async()=>{
 const ready=createCollectorReadiness({enabled:true,localVersion:'0.2.39',localReady:async()=>true,readGatewayStatus:async()=>{throw Error('must not call');}});
 assert.equal(await ready('0.2.39'),true);assert.equal(await ready('0.2.40'),false);
});
