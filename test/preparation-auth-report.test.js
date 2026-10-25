import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareConnection} from '../src/auth/prepare-connection.js';
import {createDeviceAuthorizationClient} from '../src/auth/device-authorization.js';

test('helper-owned old binding HTTP 401 reports a blocked invitation without replacing credentials or authorizing', async t => {
  const stateDir=await mkdtemp(path.join(os.tmpdir(),'sw-auth-report-'));
  t.after(()=>rm(stateDir,{recursive:true,force:true}));
  const endpoint='https://fixture.sidewisp.test',id='sw_pair_'+'r'.repeat(32);
  const credentialFile=path.join(stateDir,'sidewisp','installation.json');
  await mkdir(path.dirname(credentialFile));
  const baseline=JSON.stringify({installationId:'sw_ins_existing12345',secret:'sw_secret_'+'s'.repeat(43),status:'active'});
  await writeFile(credentialFile,baseline,{mode:0o600});
  const reports=[];let begins=0,mutations=0;
  const client=createDeviceAuthorizationClient({endpoint,stateDir,fetchImpl:async(url,options)=>{
    if(url.pathname==='/v1/device-authorizations/preparation'){
      const body=JSON.parse(options.body);assert.equal(body.id,id);reports.push(body);
      return Response.json({id,status:'waiting',preparation:{stage:body.stage,reasonCode:body.reasonCode}});
    }
    if(url.pathname==='/v1/installations/credential-status')return Response.json({error:'unauthorized'},{status:401});
    if(url.pathname==='/v1/device-authorizations/begin')begins++;
    throw Error('unexpected_request');
  }});
  const current={version:'0.2.87',endpoint,enabled:true,running:true,connectionReadiness:{ready:true},installation:{installationId:'sw_ins_existing12345'}};
  await assert.rejects(prepareConnection({targetVersion:current.version,endpoint,
    inspect:async()=>current,install:async()=>mutations++,upgrade:async()=>mutations++,activate:async()=>mutations++,
    begin:()=>client.begin({id,runtime:'openclaw'}),
    persist:({stage,reason})=>client.reportPreparation({id,stage,...(reason?{reasonCode:'preparation_failed'}:{})}),
  }),/installation_status_unavailable/);
  assert.equal(reports[0].stage,'inspecting');
  assert.equal(reports.at(-1).stage,'blocked');
  assert.equal(reports.at(-1).reasonCode,'preparation_failed');
  assert.equal(begins,0);assert.equal(mutations,0);
  assert.equal(await readFile(credentialFile,'utf8'),baseline);
});
