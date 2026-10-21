import test from 'node:test';import assert from 'node:assert/strict';import {prepareConnection} from '../src/auth/prepare-connection.js';
test('expensive deferred update cannot multiply an update-only idle deadline',async()=>{
 let time=0,attempts=0;const marks=[];
 await assert.rejects(prepareConnection({targetVersion:'0.2.74',endpoint:'https://example.test',updateOnly:true,now:()=>time,inspect:async()=>({version:'0.2.33',endpoint:'https://example.test'}),persist:s=>marks.push(s),sleep:async()=>{},
 upgrade:async()=>{attempts++;time+=60*60_000;throw Object.assign(Error('update_deferred'),{reasonCode:'ACTIVE_WORK'})}}),/host_idle_timeout/);
 assert.equal(attempts,1);assert.deepEqual(marks.at(-1),{stage:'blocked',reason:'host_idle_timeout'});
});
