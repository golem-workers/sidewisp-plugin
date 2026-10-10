#!/usr/bin/env node
import path from 'node:path';import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';import {createHash} from 'node:crypto';
import {prepareRuntimeCompanion,runtimeCompanionVersion} from '../src/auth/runtime-companion.js';
import {coldActivateOpenClaw} from './cold-activate-openclaw.mjs';
const stateDir=process.env.OPENCLAW_STATE_DIR,configPath=process.env.OPENCLAW_CONFIG_PATH;
if(!path.isAbsolute(stateDir??'')||!path.isAbsolute(configPath??''))throw Error('explicit_active_profile_required');
const mode=process.argv[2];if(!['--apply','--audit'].includes(mode)||process.argv.length!==3)throw Error('runtime_companion_argument_invalid');
const journal=path.join(stateDir,'sidewisp','runtime-companion-3989','result.json');
if(mode==='--audit'){console.log(readFileSync(journal,'utf8'));}else{
 const run=args=>execFileSync('openclaw',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000});
 const sha=v=>createHash('sha256').update(v).digest('hex');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const snapshot=()=>{const serving=JSON.parse(run(['gateway','call','sidewisp.status','--params','{}','--json']));const cfg=readFileSync(configPath);const binding=readFileSync(path.join(stateDir,'sidewisp','installation.json'));return {version:serving.version,ready:serving.connectionReadiness?.ready,endpoint:serving.endpoint,installationId:serving.installation?.installationId,configHash:sha(cfg),bindingHash:sha(binding)};};
 const before=snapshot();if(before.endpoint!=='https://staging-api.sidewisp.com'||before.version!=='0.2.63'||before.ready!==true)throw Error('staging_source_not_ready');
 const deadline=Date.now()+6*60*60*1000;let prepared;
 while(Date.now()<deadline){try{prepared=prepareRuntimeCompanion({run,stateDir,configPath});break;}catch(e){if(e.message!=='host_activation_busy')throw e;await sleep(5000);}}
 if(!prepared)throw Error('host_still_busy');
 if(prepared.activationRequired){
  let activated=false;while(Date.now()<deadline){try{await coldActivateOpenClaw({run,stateDir,configPath});activated=true;break;}catch(e){if(e.message!=='host_activation_busy')throw e;await sleep(5000);}}
  if(!activated)throw Error('host_still_busy');
 }
 let after;for(let n=0;n<90;n++){try{after=snapshot();if(after.ready===true)break;}catch{}await sleep(1000);}
 if(JSON.stringify(before)!==JSON.stringify(after))throw Error('runtime_preservation_failed');
 let previous={};try{previous=JSON.parse(readFileSync(journal,'utf8'));}catch{}
 const result={...previous,phase:'completed',version:runtimeCompanionVersion,servingPlugin:after.version,installationId:after.installationId,bindingPreserved:true,configPreserved:true,pluginReinstalled:false,observedAtMs:Date.now(),runtimeHashes:prepared.hashes};
 mkdirSync(path.dirname(journal),{recursive:true,mode:0o700});writeFileSync(journal+'.tmp',JSON.stringify(result)+'\n',{mode:0o600});renameSync(journal+'.tmp',journal);console.log(JSON.stringify(result));
}
