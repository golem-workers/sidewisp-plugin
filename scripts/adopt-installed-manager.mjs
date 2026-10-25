#!/usr/bin/env node
import {installUpdateManager} from './install-update-manager.mjs';
import {writeFileSync,renameSync} from 'node:fs';import path from 'node:path';
const stateDir=process.env.OPENCLAW_STATE_DIR,endpoint=process.argv[2];
if(!path.isAbsolute(stateDir??'')||!path.isAbsolute(process.env.OPENCLAW_CONFIG_PATH??''))throw Error('EXPLICIT_ACTIVE_PROFILE_REQUIRED');
const stateFile=path.join(stateDir,'sidewisp/manager-adoption.json');
const save=value=>{writeFileSync(stateFile+'.tmp',JSON.stringify({...value,checkedAtMs:Date.now()})+'\n',{mode:0o600});renameSync(stateFile+'.tmp',stateFile);};
for(let n=0;n<120;n++){
 try{const result=installUpdateManager({stateDir,endpoint,upgrade:true});save({status:'completed',managerVersion:result.managerVersion});break;}
 catch(e){if(e.message==='MANAGER_UPDATE_IN_PROGRESS'&&n<119){await new Promise(r=>setTimeout(r,5000));continue;}
 save({status:'failed',reasonCode:/^[A-Z_]+$/.test(e.message)?e.message:'MANAGER_ADOPTION_FAILED'});process.exitCode=1;break;}
}
