import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFileCredentialStore} from './credentials.js';

const SOURCE='https://staging-api.sidewisp.com',TARGET='https://api.sidewisp.com';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// This record represents consent explicitly supplied by the invitation command,
// not consent inferred from a mismatch, a plan hash, or server telemetry.
export async function invitationTransitionConsent({stateDir,configFile,sourceEndpoint,targetEndpoint,requestId,expiresAtMs,now=Date.now}) {
 if(sourceEndpoint!==SOURCE||targetEndpoint!==TARGET)throw Error('invitation_transition_endpoint_refused');
 if(!path.isAbsolute(stateDir??'')||!path.isAbsolute(configFile??'')||!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(requestId??'')||!Number.isSafeInteger(expiresAtMs))throw Error('invalid_invitation_transition');
 const profile={stateDir:await fs.realpath(stateDir),configFile:await fs.realpath(configFile)};
 if(profile.stateDir!==stateDir||profile.configFile!==configFile)throw Error('canonical_active_profile_required');
 const directory=path.join(stateDir,'sidewisp-transitions','invitations');
 const file=path.join(directory,requestId+'.json');
 let record;try{record=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(record && (record.schema!=='sidewisp.invitation-transition.v1'||record.stateDir!==stateDir||record.configFile!==configFile||record.sourceEndpoint!==SOURCE||record.targetEndpoint!==TARGET||record.requestId!==requestId||record.expiresAtMs!==expiresAtMs))throw Error('invitation_transition_consent_mismatch');
 const config=JSON.parse(await fs.readFile(configFile,'utf8'));
 const credential=await createFileCredentialStore({stateDir}).read();
 if(record?.planFile) {
  let receipt;try{receipt=JSON.parse(await fs.readFile(path.join(path.dirname(record.planFile),'activation.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(receipt?.status==='activated') {
   if(config.plugins?.entries?.sidewisp?.config?.endpoint!==TARGET||credential?.installationId!==receipt.targetInstallationId)throw Error('activated_profile_changed');
   return {record,file,result:{status:'activated',targetInstallationId:credential.installationId,bindingChanged:true,resumed:true}};
  }
  if(receipt)throw Error('transition_recovery_required');
 }
 if(expiresAtMs<=now())throw Error('fresh_invitation_required');
 if(config.plugins?.entries?.sidewisp?.config?.endpoint!==SOURCE||credential?.status!=='active')throw Error('source_binding_required');
 const sourceFingerprint=digest(await fs.readFile(path.join(stateDir,'sidewisp/installation.json')));
 if(record && (record.sourceFingerprint!==sourceFingerprint||record.sourceInstallationId!==credential.installationId))throw Error('source_profile_changed');
 if(!record) {
  record={schema:'sidewisp.invitation-transition.v1',...profile,sourceEndpoint:SOURCE,targetEndpoint:TARGET,requestId,expiresAtMs,sourceFingerprint,sourceInstallationId:credential.installationId};
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  try{await fs.writeFile(file,JSON.stringify(record),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;return invitationTransitionConsent({stateDir,configFile,sourceEndpoint,targetEndpoint,requestId,expiresAtMs,now});}
 }
 return {record,file};
}
export async function bindInvitationTransitionPlan({consent,planFile,plan}) {
 const {record,file}=consent;
 if(plan.invitation?.requestId!==record.requestId||plan.invitation?.expiresAtMs!==record.expiresAtMs)throw Error('invitation_transition_consent_mismatch');
 if(plan.stateDir!==record.stateDir||plan.configFile!==record.configFile||plan.sourceFingerprint!==record.sourceFingerprint||plan.sourceInstallationId!==record.sourceInstallationId||plan.sourceEndpoint!==record.sourceEndpoint||plan.targetEndpoint!==record.targetEndpoint||record.planFile&&record.planFile!==planFile)throw Error('source_profile_changed');
 const next={...record,planFile};const tmp=file+'.'+process.pid+'.tmp';await fs.writeFile(tmp,JSON.stringify(next),{mode:0o600});await fs.rename(tmp,file);
 return next;
}
