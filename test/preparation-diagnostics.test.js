import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {recordPreparationFailure} from '../src/auth/preparation-diagnostics.js';

test('typed reuse refusal retains HTTP status/reason in private diagnostics, not public metadata',async()=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sw-failure-'));
 try{
  const failure=recordPreparationFailure({stateDir,step:'verifying',error:Object.assign(Error('existing_authorization_reuse_failed'),{status:404,reason:'authorization_not_found'})});
  const file=path.join(stateDir,'sidewisp/preparation-diagnostics',failure.diagnosticId+'.json');
  const stored=JSON.parse(await readFile(file,'utf8'));
  assert.equal(stored.httpStatus,404);assert.equal(stored.httpReason,'authorization_not_found');
  assert.equal(stored.message,'existing_authorization_reuse_failed');assert.equal((await stat(file)).mode&0o777,0o600);
  assert.deepEqual(Object.keys(failure).sort(),['code','diagnosticId','step']);
 }finally{await rm(stateDir,{recursive:true,force:true});}
});
test('untrusted backend reason and invalid HTTP status are not persisted as structured diagnostic fields',async()=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sw-failure-'));
 try{
  const failure=recordPreparationFailure({stateDir,step:'verifying',error:Object.assign(Error('preparation_failed'),{status:999,reason:'private_subject_or_secret'})});
  const stored=JSON.parse(await readFile(path.join(stateDir,'sidewisp/preparation-diagnostics',failure.diagnosticId+'.json'),'utf8'));
  assert.equal(stored.httpStatus,undefined);assert.equal(stored.httpReason,undefined);assert.doesNotMatch(JSON.stringify(stored),/private_subject_or_secret/);
 }finally{await rm(stateDir,{recursive:true,force:true});}
});
