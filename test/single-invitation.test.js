import {createConnectTool} from '../src/adapters/openclaw/connect-tool.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';
import {createEnrollmentManager,createFileCredentialStore} from '../src/auth/credentials.js';
import {synchronizeCollectorAuthorization} from '../src/auth/collector-authorization.js';
import {createUploader} from '../src/delivery/uploader.js';
// Backend responses and spool are fixtures. Authorization, atomic credential storage,
// running collector synchronization, and request signing use the real implementation.
for (const runtime of ['openclaw','hermes']) for (const externalCompletion of [false,true]) test(`one ${runtime} invitation + one approval reaches signed acknowledgement; helper=${externalCompletion}`,async()=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-one-invitation-'));
 const id='sw_pair_'+'q'.repeat(32), installationId='sw_ins_newbinding001';
 const secret='sw_secret_'+crypto.randomBytes(32).toString('hex');
 const store=createFileCredentialStore({stateDir});
 let approved=false,proof,beginCount=0,ack=false,accepted=false;
 const fetchImpl=async(url,options)=>{
  if(url.pathname.endsWith('/credential-status'))return {status:401,json:async()=>({schema:'sidewisp.credential-status.v1',status:'rejected'})};
  const body=JSON.parse(options.body);
  if(url.pathname.endsWith('/begin')){
   beginCount++;proof=body.deviceSecret;
   return {ok:true,json:async()=>({id,userCode:'ABCD123456',expiresAtMs:Date.now()+60000})};
  }
  assert.equal(body.deviceSecret,proof);
  if(body.acknowledge){ack=true;assert.equal((await store.read()).installationId,installationId);return {ok:true,json:async()=>({status:'completed'})};}
  return {ok:true,json:async()=>approved?{status:'approved',credential:{installationId,installationSecret:secret}}:{status:'pending'}};
 };
 try{
  await store.write({installationId:'sw_ins_oldbinding001',secret:'sw_secret_'+'o'.repeat(32),status:'active'});
  const auth=createEnrollmentManager({endpoint:'https://example.test',store});await auth.load();
  const device=createDeviceAuthorizationClient({endpoint:'https://example.test',stateDir,fetchImpl});
  const invitation=runtime==='openclaw'
    ? await createConnectTool({endpoint:'https://example.test',stateDir,fetchImpl,ready:async()=>true})
      .execute('connect',{requestId:id,endpoint:'https://example.test'})
    : await device.begin({id,runtime});
  if(runtime==='openclaw')assert.equal(invitation.details.status,'approval_pending');
  assert.ok(!JSON.stringify(invitation).includes(proof));
  await synchronizeCollectorAuthorization({device,auth});
  assert.equal(auth.credential().installationId,'sw_ins_oldbinding001');
  approved=true; // The only simulated user action after the initial invitation.
  if(externalCompletion)await device.poll();
  await synchronizeCollectorAuthorization({device,auth});
  assert.equal(beginCount,1);assert.equal(ack,true);
  assert.equal(auth.credential().installationId,installationId);
  let events=[{eventId:'first-heartbeat',installationId,type:'heartbeat'}];
  const spool={pending:n=>events.slice(0,n).map(event=>({event,eventId:event.eventId})),acknowledge:ids=>{events=events.filter(e=>!ids.includes(e.eventId));},deadLetter:()=>assert.fail('unexpected dead letter')};
  const uploader=createUploader({endpoint:'https://example.test',spool,credentialProvider:{current:async()=>auth.credential()},fetchImpl:async(_url,options)=>{
   assert.ok(ack&&approved);
   const h=options.headers,digest=crypto.createHash('sha256').update(options.body).digest('hex');
   const expected=crypto.createHmac('sha256',secret).update(`${h['x-sidewisp-timestamp']}\n${h['x-sidewisp-nonce']}\n${digest}`).digest('hex');
   assert.equal(h.authorization,`Sidewisp ${installationId}:${expected}`);
   accepted=true;return {status:200,ok:true,json:async()=>({acknowledgedEventIds:['first-heartbeat']})};
  }});
  assert.equal((await uploader.sendOnce()).sent,1);
  assert.equal(accepted,true);assert.ok(uploader.status().lastDeliveredAt);
 }finally{await fs.rm(stateDir,{recursive:true,force:true});}
});
