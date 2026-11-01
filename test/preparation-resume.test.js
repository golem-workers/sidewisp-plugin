import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConnection} from '../src/auth/prepare-connection.js';
const ready={version:'0.2.74',endpoint:'https://example.test',enabled:true,running:true,installation:{installationId:'same'},connectionReadiness:{ready:true}};
test('legacy .33 preparation resumes a deferred updater, preserves binding and begins once',async()=>{
 let upgrades=0,begins=0;const states=[];
 const result=await prepareConnection({targetVersion:ready.version,endpoint:ready.endpoint,
 inspect:async()=>upgrades>1?ready:{...ready,version:'0.2.33'},persist:s=>states.push(s),sleep:async()=>{},
 upgrade:async()=>{if(++upgrades===1)throw Object.assign(Error('update_deferred'),{reasonCode:'ACTIVE_WORK'});},
 begin:async()=>{begins++;return{id:'public',autoConnect:true,expiresAtMs:100};}});
 assert.equal(result.status,'connection_pending');assert.equal(upgrades,2);assert.equal(begins,1);
 assert.ok(states.some(s=>s.stage==='waiting_for_host_idle'&&s.reasonCode==='ACTIVE_WORK'));
 assert.equal(states.at(-1).stage,'connection_pending');
});
test('terminal updater failure and permission refusal are not retried',async()=>{
 for(const reason of ['update_failed','policy_denied']){let upgrades=0,begins=0;
 await assert.rejects(prepareConnection({targetVersion:ready.version,endpoint:ready.endpoint,
 inspect:async()=>({...ready,version:'0.2.33'}),persist:()=>{},sleep:async()=>{},
 upgrade:async()=>{upgrades++;throw Error(reason)},begin:async()=>{begins++}}),new RegExp(reason));
 assert.equal(upgrades,1);assert.equal(begins,0);}
});
test('waiting beyond the former two-minute budget still resumes without an extra command',async()=>{
 let attempts=0;const states=[];
 await prepareConnection({targetVersion:ready.version,endpoint:ready.endpoint,inspect:async()=>ready,persist:s=>states.push(s),sleep:async()=>{},
 prepareRuntime:async()=>{if(++attempts<125)throw Error('host_activation_busy');return{changed:false};},begin:async()=>({id:'public',expiresAtMs:100})});
 assert.equal(attempts,125);assert.equal(states.filter(s=>s.stage==='waiting_for_host_idle').length,124);
});
