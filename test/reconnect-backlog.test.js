import assert from 'node:assert/strict';
import test from 'node:test';
import { createUploader } from '../src/delivery/uploader.js';
test('more than one old-binding batch cannot postpone the new first heartbeat or report a false empty queue',async()=>{
 const installationId='sw_ins_new12345678';
 const rows=[...Array.from({length:7},(_,n)=>({eventId:'old-'+n,installationId:'sw_ins_old12345678'})),{eventId:'first-heartbeat',installationId}];
 const quarantined=[],sent=[];
 const spool={
  pending:limit=>rows.slice(0,limit).map(event=>({eventId:event.eventId,event})),
  deadLetter:(id,reason)=>{quarantined.push([id,reason]);rows.splice(rows.findIndex(x=>x.eventId===id),1)},
  acknowledge:ids=>{for(const id of ids)rows.splice(rows.findIndex(x=>x.eventId===id),1)},
 };
 const uploader=createUploader({spool,maxBatch:2,endpoint:'https://example.test',credentialProvider:{current:async()=>({installationId,secret:'local-secret',status:'active'})},
 fetchImpl:async(_url,input)=>{
  const events=JSON.parse(input.body).events;
  assert.deepEqual(events.map(x=>x.installationId),[installationId]);
  sent.push(...events.map(x=>x.eventId));
  return {ok:true,status:200,json:async()=>({acknowledgedEventIds:events.map(x=>x.eventId)})};
 }});
 assert.equal((await uploader.sendOnce()).status,'dead-lettered');
 assert.equal(uploader.status().remaining,1);
 assert.equal((await uploader.drain({maxAttempts:4})).status,'idle');
 assert.deepEqual(sent,['first-heartbeat']);
 assert.equal(quarantined.length,7);
 assert.ok(quarantined.every(([,reason])=>reason==='previous-installation'));
 assert.equal(rows.length,0);
});
