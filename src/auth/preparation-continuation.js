import fs from 'node:fs/promises';
import path from 'node:path';
import {telegramReplyRoute,sendTelegramConnectionReply} from './connection-notice.js';
import {planEndpointTransition} from './endpoint-transition.js';

// Planning is local and read-only with respect to the active binding. Neither
// this function nor its returned action constitutes host/account approval.
export async function preparationContinuation({stateDir,configFile,sourceEndpoint,targetEndpoint,requestId,expiresAtMs,now=Date.now}) {
 const base={status:'blocked',bindingPreserved:true,sourceUpdate:'completed'};
 if(!Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now())return {...base,reason:'fresh_invitation_required',nextAction:{type:'fresh_invitation_required'}};
 const plan=await planEndpointTransition({stateDir,configFile,sourceEndpoint,targetEndpoint});
 const directory=path.dirname(plan.candidateStateDir);
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const planFile=path.join(directory,'plan.json');
 try {await fs.writeFile(planFile,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});}
 catch(error){if(error.code!=='EEXIST')throw error;const existing=JSON.parse(await fs.readFile(planFile,'utf8'));if(JSON.stringify(existing)!==JSON.stringify(plan))throw Error('source_profile_changed');}
 return {...base,reason:'existing_endpoint_mismatch',nextAction:{type:'confirm_endpoint_transition',planFile,sourceEndpoint,targetEndpoint,requestId,expiresAtMs,confirmation:plan.confirmation}};
}

// An explicitly supplied initiating-chat route is used only for the safe
// confirmation question, never for proofs, credentials or automatic approval.
export async function notifyPreparationContinuation({stateDir,requestId,action,route,send=sendTelegramConnectionReply}) {
 const trusted=telegramReplyRoute(route);if(!trusted)throw Error('invalid_connection_reply_route');
 const directory=path.join(stateDir,'sidewisp','preparation-notices');
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,requestId+'.json');
 try {return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const text=action.type==='confirm_endpoint_transition'
  ? `Обновление Sidewisp завершено; прежнее подключение сохранено. Для новой заявки требуется переход с ${action.sourceEndpoint} на ${action.targetEndpoint}. Подтвердите именно этот переход. Без вашего подтверждения подключение не меняю; далее — штатная авторизация новой заявки в приложении.`
  : 'Обновление Sidewisp завершено; прежнее подключение сохранено. Заявка истекла: создайте новую и отправьте свежую инструкцию.';
 const receipt=await send(trusted,text);if(!receipt?.messageId)throw Error('connection_reply_receipt_missing');
 const result={requestId,type:action.type,messageId:String(receipt.messageId)};
 const temporary=file+'.'+process.pid+'.tmp';await fs.writeFile(temporary,JSON.stringify(result),{mode:0o600});await fs.rename(temporary,file);return result;
}
