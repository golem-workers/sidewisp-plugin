import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnectTool, registerConnectTool } from '../src/adapters/openclaw/connect-tool.js';
const endpoint = 'https://example.test';
const requestId = 'sw_pair_' + 'x'.repeat(32);
test('host admission exposes tool only to owner', () => {
 let factory; registerConnectTool({registerTool(fn){factory=fn;}},{endpoint,stateDir:'/tmp/unused',ready:async()=>true});
 assert.equal(factory({}),null); assert.equal(factory({senderIsOwner:false}),null);
 assert.equal(factory({senderIsOwner:true}).name,'sidewisp_connect');
});
test('unready collector and input injection cannot create requests',async()=>{
 let calls=0;
 const tool=createConnectTool({endpoint,stateDir:'/tmp/unused',ready:async()=>false,fetchImpl:async()=>{calls++;throw Error('unexpected');}});
 for(const input of [{requestId,endpoint},{requestId,endpoint:'https://attacker.test'},{requestId,endpoint,stateDir:'/tmp/other'},{requestId:'bad',endpoint}])assert.equal((await tool.execute('test',input)).isError,true);
 assert.equal(calls,0);
});
test('serialized begin hides codes, links, proofs and transport errors',async()=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'sw-tool-'));
 let release,entered,fail=false;
 const waiting=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const tool=createConnectTool({endpoint,stateDir,ready:async()=>true,fetchImpl:async()=>{
  entered();await waiting;if(fail)throw Error('secret value must not escape');
  return {ok:true,json:async()=>({id:requestId,userCode:'12345ABCDE',expiresAtMs:Date.now()+60000})};
 }});
 try{
  const pending=tool.execute('one',{requestId,endpoint});await started;
  assert.equal((await tool.execute('two',{requestId,endpoint})).details.reason,'connection_request_in_progress');
  release();const result=await pending;
  assert.equal(result.details.status,'approval_pending');assert.doesNotMatch(JSON.stringify(result),/sw_device_|12345ABCDE|verificationUri/);
  fail=true;const error=await tool.execute('retry',{requestId,endpoint});
  assert.equal(error.details.reason,'connection_preparation_failed');assert.doesNotMatch(JSON.stringify(error),/secret value/);
 }finally{await fs.rm(stateDir,{recursive:true,force:true});}
});
