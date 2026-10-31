#!/usr/bin/env node
import fs from 'node:fs/promises';
import { planEndpointTransition,beginEndpointTransition,pollEndpointTransition,verifyEndpointTransitionReady } from '../src/auth/endpoint-transition.js';
try {
 const [action,file,confirmation,requestId]=process.argv.slice(2);
 if(!file?.startsWith('/'))throw Error('absolute_plan_file_required');
 let result;
 if(action==='plan'){
  const plan=await planEndpointTransition({stateDir:process.env.OPENCLAW_STATE_DIR,configFile:process.env.OPENCLAW_CONFIG_PATH});
  await fs.writeFile(file,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
  result={status:'confirmation_required',confirmation:plan.confirmation,sourceEndpoint:plan.sourceEndpoint,targetEndpoint:plan.targetEndpoint,bindingChanged:false};
 } else {
  const plan=JSON.parse(await fs.readFile(file,'utf8'));
  if(action==='begin')result=await beginEndpointTransition({plan,confirmation,requestId});
  else if(action==='poll')result=await pollEndpointTransition({plan});
  else if(action==='ready')result=await verifyEndpointTransitionReady({plan});
  else throw Error('expected_plan_begin_poll_or_ready');
 }
 // Do not emit fallback link/code, even from the normal authorization client.
 const {userCode,verificationUri,...publicResult}=result;
 console.log(JSON.stringify(publicResult));
} catch(error){console.error(/^[a-z_0-9]+$/.test(error.message)?error.message:'endpoint_transition_failed');process.exitCode=1;}
