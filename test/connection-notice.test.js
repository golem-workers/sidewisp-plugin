import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createConnectionNotifier,saveConnectionReply,recordAuthorizationCompletion,telegramReplyRoute,sendConnectionDelay,createRuntimeTelegramSender} from '../src/auth/connection-notice.js';
const endpoint='https://example.test',requestId='sw_pair_'+'x'.repeat(32),installationId='sw_ins_fixture';
async function fixture(t){const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-notice-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));return{stateDir,endpoint,requestId};}
test('confirmation requires the same request, binding and acknowledged health; retries and restart stay single',async t=>{const f=await fixture(t),sent=[];await saveConnectionReply({...f,route:{channel:'telegram',to:'-123',accountId:'default'}});const options={...f,send:async route=>{sent.push(route);return{messageId:'7'};}};let notifier=createConnectionNotifier(options);await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);assert.equal(sent.length,0);await recordAuthorizationCompletion({...f,installationId});await notifier.acknowledged([{type:'turn.completed',installationId:'another'}]);await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);assert.equal(sent.length,1);for(let i=0;i<3;i++)await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);notifier=createConnectionNotifier(options);await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);assert.equal(sent.length,1);assert.equal(sent[0].target,'-123');});
test('usage, wrong binding and rejected heartbeat cannot send a success',async t=>{const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'123'}});await recordAuthorizationCompletion({...f,installationId});let sent=0;const notifier=createConnectionNotifier({...f,send:async()=>{sent++;return{messageId:'8'};}});await notifier.acknowledged([{type:'turn.completed',installationId}]);await notifier.acknowledged([{type:'health.snapshot',installationId:'old'}]);assert.equal(sent,0);});
test('failed channel delivery retries only after accepted health and concurrent callbacks coalesce',async t=>{const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'123'}});await recordAuthorizationCompletion({...f,installationId});let sent=0;const notifier=createConnectionNotifier({...f,send:async()=>{if(++sent===1)throw Error('offline');return{messageId:'9'};}});await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);await Promise.all(Array.from({length:20},()=>notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}])));assert.equal(sent,2);});
for(const reason of ['ACTIVE_WORK','HOST_RETAINED_WORK','IDLE_WINDOW_TIMEOUT','waiting_for_readiness','preparation_queued'])test(`ordinary wait ${reason} is silent and does not consume the blocker receipt`,async t=>{
 const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'123'}});const messages=[];
 const send=async(_,text)=>{messages.push(text);return{messageId:'10'};};
 for(let i=0;i<3;i++)await sendConnectionDelay({...f,reason,send});
 assert.deepEqual(messages,[]);
 await assert.rejects(fs.access(path.join(f.stateDir,'sidewisp',`connection-delay-${requestId}.json`)),{code:'ENOENT'});
 await sendConnectionDelay({...f,reason:'fresh_invitation_required',send});assert.equal(messages.length,1);assert.match(messages[0],/Заявка истекла/);
});
for(const reason of ['fresh_invitation_required','host_idle_timeout','collector_not_ready'])test(`real blocker ${reason} remains concise and durable across retries`,async t=>{
 const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'123',accountId:'default',threadId:'7'}});const messages=[];
 const send=async(route,text)=>{messages.push({route,text});return{messageId:'11'};};
 for(let i=0;i<3;i++)await sendConnectionDelay({...f,reason,send});
 assert.equal(messages.length,1);assert.equal(messages[0].route.threadId,'7');assert.ok(messages[0].text.length<160);
 const receipt=JSON.parse(await fs.readFile(path.join(f.stateDir,'sidewisp',`connection-delay-${requestId}.json`),'utf8'));assert.equal(receipt.reason,reason);
});
test('invalid or unrelated routes are not accepted',()=>{assert.equal(telegramReplyRoute({channel:'slack',to:'123'}),null);assert.equal(telegramReplyRoute({channel:'telegram',to:'@attacker'}),null);});

test('native runtime adapter returns real receipt without invoking nested CLI; preserves account and topic',async()=>{
 const cfg={channels:{telegram:{enabled:true}}},calls=[];
 const send=createRuntimeTelegramSender({config:cfg,runtime:{channel:{outbound:{loadAdapter:async id=>{assert.equal(id,'telegram');return{sendText:async ctx=>{calls.push(ctx);return{channel:'telegram',messageId:'native-1'};}};}}}}});
 assert.deepEqual(await send({channel:'telegram',target:'-123',accountId:'work',threadId:'42'}),{messageId:'native-1'});
 assert.deepEqual(calls,[{cfg,to:'-123',text:'Агент подключён к Sidewisp',accountId:'work',threadId:'42'}]);
});
test('native delivery failure, disabled account and absent native channel never fall back to CLI',async()=>{
 const route={channel:'telegram',target:'-123',accountId:'work'};let calls=0;
 const runtime={channel:{outbound:{loadAdapter:async()=>({sendText:async()=>{calls++;throw Error('native-offline');}})}}};
 await assert.rejects(createRuntimeTelegramSender({config:{},runtime})(route),/native-offline/);assert.equal(calls,1);
 await assert.rejects(createRuntimeTelegramSender({config:{channels:{telegram:{enabled:false}}},runtime})(route),/telegram_account_disabled/);assert.equal(calls,1);
 await assert.rejects(createRuntimeTelegramSender({config:{channels:{telegram:{accounts:{work:{enabled:false}}}}},runtime})(route),/telegram_account_disabled/);assert.equal(calls,1);
 await assert.rejects(createRuntimeTelegramSender({config:{},runtime:{channel:{outbound:{loadAdapter:async()=>undefined}}}})(route),/telegram_channel_unavailable/);
 await assert.rejects(createRuntimeTelegramSender({config:{},runtime:{channel:{outbound:{loadAdapter:async()=>({sendText:async()=>({outcome:'suppressed',messageId:'not-sent'})})}}}})(route),/connection_reply_receipt_missing/);
});
test('older native Telegram runtime keeps topic and account routing',async()=>{
 const cfg={},calls=[];const send=createRuntimeTelegramSender({config:cfg,runtime:{channel:{telegram:{sendMessageTelegram:async(...args)=>{calls.push(args);return{messageId:17};}}}}});
 assert.deepEqual(await send({channel:'telegram',target:'123',accountId:'default',threadId:'7'},'delay'),{messageId:'17'});
 assert.deepEqual(calls,[['123','delay',{cfg,accountId:'default',messageThreadId:7}]]);
 await assert.rejects(send({channel:'telegram',target:'123',threadId:'99999999999999999999'}),/invalid_connection_reply_thread/);
});
test('native channel confirmation remains acknowledgement-gated and durable across reloads',async t=>{
 const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'-123'}});await recordAuthorizationCompletion({...f,installationId});let sent=0;
 const send=createRuntimeTelegramSender({config:{},runtime:{channel:{outbound:{loadAdapter:async()=>({sendText:async()=>{sent++;return{messageId:'native-proof'};}})}}}});
 let notice=createConnectionNotifier({...f,send});await notice.acknowledged([{type:'turn.completed',installationId}]);assert.equal(sent,0);
 await notice.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);notice=createConnectionNotifier({...f,send});await notice.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date().toISOString()}]);assert.equal(sent,1);
});

test('stale or pre-authorization health from backlog cannot announce a completed connection',async t=>{
 const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'123'}});await recordAuthorizationCompletion({...f,installationId});let sent=0;
 const now=Date.now()+1000,notifier=createConnectionNotifier({...f,now:()=>now,send:async()=>{sent++;return{messageId:'fresh'};}});
 for(const occurredAt of [undefined,new Date(now-180000).toISOString(),new Date(now+1).toISOString(),new Date(now-2000).toISOString()]) {
  await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt}]);assert.equal(sent,0);
 }
 await notifier.acknowledged([{type:'health.snapshot',installationId,occurredAt:new Date(now).toISOString()}]);assert.equal(sent,1);
});

test('a fresh accepted health in a mixed historical batch wins regardless of batch order',async t=>{
 const f=await fixture(t);await saveConnectionReply({...f,route:{channel:'telegram',to:'123'}});await recordAuthorizationCompletion({...f,installationId});let sent=0;const now=Date.now()+1000;
 const notifier=createConnectionNotifier({...f,now:()=>now,send:async()=>{sent++;return{messageId:'mixed'};}});
 await notifier.acknowledged([
  {type:'health.snapshot',installationId,occurredAt:new Date(now).toISOString()},
  {type:'health.snapshot',installationId,occurredAt:new Date(now-180000).toISOString()},
  {type:'health.snapshot',installationId,occurredAt:new Date(now+999999).toISOString()},
 ]);assert.equal(sent,1);
});
