import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export function telegramReplyRoute(route) {
 const channel=route?.channel??route?.messageChannel;
 const target=String(route?.to??route?.target??route?.nativeChannelId??'').replace(/^telegram:/,'');
 const accountId=route?.accountId??route?.agentAccountId;
 const threadId=route?.threadId;
 if(channel!=='telegram'||! /^-?[0-9]{1,20}$/.test(target)
   ||accountId!==undefined&&!/^[A-Za-z0-9_-]{1,100}$/.test(accountId)
   ||threadId!==undefined&&!/^[0-9]{1,20}$/.test(String(threadId)))return null;
 return {channel:'telegram',target,...(accountId?{accountId}:{}),...(threadId!==undefined?{threadId:String(threadId)}:{})};
}
async function atomic(file,value){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+process.pid+'.tmp';await fs.writeFile(temporary,JSON.stringify(value),{mode:0o600});await fs.rename(temporary,file);}
export async function saveConnectionReply({stateDir,endpoint,requestId,route}) {
 if(!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(requestId))throw Error('invalid_device_request');
 const validated=telegramReplyRoute(route);if(!validated)throw Error('invalid_connection_reply_route');
 const file=path.join(stateDir,'sidewisp','connection-reply.json');
 let old;try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(old?.requestId===requestId&&old.endpoint===endpoint)return;
 await atomic(file,{endpoint,requestId,route:validated});
}
export async function recordAuthorizationCompletion({stateDir,endpoint,requestId,installationId}) {
 await atomic(path.join(stateDir,'sidewisp','authorization-completed.json'),{endpoint,requestId,installationId});
}
export async function sendTelegramConnectionReply(route, text = 'Агент подключён к Sidewisp') {
 const args=['message','send','--channel','telegram','--target',route.target,'--message',text,'--json'];
 if(route.accountId)args.push('--account',route.accountId);
 if(route.threadId)args.push('--thread-id',route.threadId);
 const {stdout}=await execute('openclaw',args,{timeout:30000,maxBuffer:65536});
 const receipt=JSON.parse(stdout);const id=receipt?.payload?.messageId??receipt?.result?.messageId??receipt?.messageId;
 if(!id)throw Error('connection_reply_receipt_missing');
 return {messageId:String(id)};
}
export function createConnectionNotifier({stateDir,endpoint,send=sendTelegramConnectionReply,onError=()=>{}}) {
 let flight=null,acceptedId=null;
 async function deliver(){
  try{
   const file=path.join(stateDir,'sidewisp','connection-reply.json');
   const [reply,completion]=await Promise.all([fs.readFile(file,'utf8').then(JSON.parse),fs.readFile(path.join(stateDir,'sidewisp','authorization-completed.json'),'utf8').then(JSON.parse)]);
   const receiptFile=path.join(stateDir,'sidewisp',`connection-receipt-${reply.requestId}.json`);
   try{await fs.access(receiptFile);return;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(reply.endpoint!==endpoint||completion.endpoint!==endpoint||reply.requestId!==completion.requestId||acceptedId!==completion.installationId)return;
   const route=telegramReplyRoute({...reply.route,to:reply.route.target});if(!route)return;
   const receipt=await send(route);if(!receipt?.messageId)throw Error('connection_reply_receipt_missing');
   await atomic(receiptFile,{requestId:reply.requestId,installationId:acceptedId,messageId:String(receipt.messageId)});
  }catch(error){if(error.code!=='ENOENT')onError('connection_reply_unavailable');}
 }
 return {acknowledged(events){for(const e of events)if(e.type==='health.snapshot')acceptedId=e.installationId;if(!acceptedId)return; if(!flight)flight=deliver().finally(()=>{flight=null;});return flight;},async stop(){if(flight)await flight;}};
}

export async function sendConnectionDelay({stateDir,endpoint,requestId,reason,send=sendTelegramConnectionReply}) {
 const messages={ACTIVE_WORK:'Агент занят текущей задачей. Подключение продолжится автоматически после её завершения.',HOST_RETAINED_WORK:'Агент занят текущей задачей. Подключение продолжится автоматически после её завершения.',fresh_invitation_required:'Заявка истекла. Создайте новую в Sidewisp и отправьте агенту свежую инструкцию.',host_idle_timeout:'Подготовка остановлена: агент не освободился. Завершите текущую работу и повторите подключение в Sidewisp.',collector_not_ready:'Агент не запустил сборщик Sidewisp. Проверьте его запуск и повторите подключение; настройки сохранены.'};
 if(!messages[reason])return;
 try {const file=path.join(stateDir,'sidewisp','connection-reply.json');const reply=JSON.parse(await fs.readFile(file,'utf8'));
  if(reply.requestId!==requestId||reply.endpoint!==endpoint)return;
  const receiptFile=path.join(stateDir,'sidewisp',`connection-delay-${requestId}.json`);
  try{await fs.access(receiptFile);return;}catch(e){if(e.code!=='ENOENT')throw e;}
  const route=telegramReplyRoute(reply.route);if(!route)return;
  const receipt=await send(route,messages[reason]);if(!receipt?.messageId)throw Error('connection_reply_receipt_missing');
  await atomic(receiptFile,{requestId,reason,messageId:String(receipt.messageId)});
 }catch(error){if(error.code!=='ENOENT')throw error;}
}
