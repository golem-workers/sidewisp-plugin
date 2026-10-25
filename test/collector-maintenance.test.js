import test from 'node:test';import assert from 'node:assert/strict';
import {maintenancePlan,repairCollector} from '../src/update/collector-maintenance.js';
const credential={status:'active',installationId:'sw_ins_fixture123',secret:'private'},baseline={endpoint:'https://staging-api.sidewisp.com',installationId:credential.installationId,stateId:'state-id',version:'0.2.87'};
const current={enabled:true,running:false,version:baseline.version,endpoint:baseline.endpoint,installation:{installationId:credential.installationId},connectionReadiness:{ready:false,stateId:baseline.stateId}};
const input={credential,baseline,endpoint:baseline.endpoint,stateId:baseline.stateId,current,attempt:{status:'completed'},journal:{status:'completed'}};
test('completed update remains terminal while liveness repair continues with grace and backoff',()=>{
 const before=structuredClone(input);let p=maintenancePlan({...input,now:1000});assert.equal(p.due,false);
 p=maintenancePlan({...input,state:p.state,now:121000});assert.equal(p.due,true);assert.deepEqual(input,before);
 assert.equal(maintenancePlan({...input,state:{...p.state,nextAttemptAtMs:200000},now:121000}).due,false);
 for(const change of [{credential:{...credential,status:'revoked'}},{baseline:{...baseline,stateId:'other'}},{current:{...current,enabled:false}},{attempt:{status:'failed'}},{journal:{status:'updating'}}])assert.equal(maintenancePlan({...input,...change,state:p.state,now:300000}).due,false);
 const healthy={...current,running:true,connectionReadiness:{...current.connectionReadiness,ready:true}};assert.equal(maintenancePlan({...input,current:healthy,state:p.state,now:300000}).state.status,'healthy');
});
const options=(changes={})=>{let calls=0;return {...input,status:async()=>++calls>1?{...current,running:true,connectionReadiness:{...current.connectionReadiness,ready:true}}:current,health:async()=>({ok:true}),inspect:async()=>({version:baseline.version}),enabled:()=>true,idle:async()=>true,reload:async()=>{},activate:async()=>assert.fail('no activation'),verifyBinding:async()=>{},sleep:async()=>{},...changes};};
test('repair reloads only existing installed plugin and verifies the preserved binding',async()=>{
 let reloads=0;assert.equal(await repairCollector(options({reload:async()=>reloads++})),'recovered');assert.equal(reloads,1);
 assert.equal(await repairCollector(options({idle:async()=>false,reload:async()=>assert.fail('busy host')})),'deferred');
 for(const change of [{enabled:()=>false},{credential:{...credential,installationId:'other'}},{inspect:async()=>({version:'0.2.88'})},{verifyBinding:async()=>{throw Error('BINDING_CHANGED');}}])await assert.rejects(repairCollector(options(change)));
 await assert.rejects(repairCollector(options({status:async()=>{throw Error('RPC');},health:async()=>({ok:false})})),/GATEWAY_UNAVAILABLE/);
 await assert.rejects(repairCollector(options({status:async()=>current,maxAttempts:2})),/COLLECTOR_RECOVERY_PENDING/);
});
test('missing plugin RPC repairs via live Gateway; post-reload binding change aborts',async()=>{
 let probes=0;assert.equal(await repairCollector(options({status:async()=>{if(++probes===1)throw Error('METHOD_MISSING');return {...current,running:true,connectionReadiness:{...current.connectionReadiness,ready:true}};}})),'recovered');
 let count=0;await assert.rejects(repairCollector(options({status:async()=>++count>1?{...current,endpoint:'https://other.example'}:current})),/BINDING_CHANGED/);
});

test('failed startup recovery uses the original service, not plugin reload or Gateway activation',async()=>{
 let starts=0;
 assert.equal(await repairCollector(options({status:(()=>{let n=0;return async()=>++n===1?{...current,recovery:{available:true}}:{...current,running:true,connectionReadiness:{...current.connectionReadiness,ready:true}};})(),restart:async()=>starts++,reload:async()=>assert.fail('must preserve generation'),activate:async()=>assert.fail('must preserve Gateway')})),'recovered');
 assert.equal(starts,1);
});
