import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,unlinkSync} from 'node:fs';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const directive={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.88',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.88',sha256:'a'.repeat(64),revision:'resume-88',mandatory:true,restartDelaySeconds:30};
const credential={status:'active',installationId:'sw_ins_resume_fixture',secret:'sw_secret_'+'a'.repeat(32)};
async function until(check,child) {
 for(let n=0;n<150;n++) {
  if(check())return;
  if(child.exitCode!==null)throw Error('manager exited '+child.exitCode);
  await delay(20);
 }
 throw Error('manager observation timed out');
}
test('actual manager retains accepted policy across process replacement and offline worker handoff', {timeout:15000}, async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'sw-manager-resume-'));
 const stateDir=path.join(root,'state'),directory=path.join(stateDir,'sidewisp'),bin=path.join(root,'bin');
 mkdirSync(directory,{recursive:true});mkdirSync(bin);
 const config=path.join(root,'manager.json'),statusFile=path.join(root,'status.json'),busy=path.join(root,'busy'),calls=path.join(root,'calls');
 const installationFile=path.join(directory,'installation.json');
 writeFileSync(installationFile,JSON.stringify(credential),{mode:0o600});
 writeFileSync(config,JSON.stringify({schema:'sidewisp.update-manager.v1',stateDir,endpoint:'https://sidewisp.test'}));
 writeFileSync(statusFile,JSON.stringify({version:'0.2.87',endpoint:'https://sidewisp.test',enabled:true,running:true,installation:{installationId:credential.installationId},connectionReadiness:{ready:true,stateId:createHash('sha256').update(stateDir).digest('hex')}}));
 writeFileSync(path.join(bin,'openclaw'),'#!/bin/sh\ncat "$FIXTURE_STATUS"\n',{mode:0o700});
 writeFileSync(path.join(bin,'systemctl'),'#!/bin/sh\nif test -f "$FIXTURE_BUSY"; then echo active; else echo inactive; fi\n',{mode:0o700});
 writeFileSync(path.join(bin,'systemd-run'),'#!/bin/sh\nprintf "%s\\n" "$@" >> "$FIXTURE_CALLS"\ntouch "$FIXTURE_BUSY"\n',{mode:0o700});
 writeFileSync(busy,'active');
 let currentChild;
 t.after(()=>{if(currentChild?.exitCode===null)currentChild.kill('SIGKILL');rmSync(root,{recursive:true,force:true});});
 const start=online=>{
  const source=`process.argv[2]=process.env.FIXTURE_CONFIG;
   globalThis.fetch=async url=>{
    if(!${online}) throw Error('CONTROL_UNAVAILABLE');
    if(url.pathname.endsWith('update-heartbeat'))return new Response(JSON.stringify({schema:'sidewisp.update-heartbeat.v1',installationId:${JSON.stringify(credential.installationId)},update:null}));
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({schema:'sidewisp.update-events.v1',installationId:${JSON.stringify(credential.installationId)},update:${JSON.stringify(directive)}})+'\\n\\n'));}}),{headers:{'content-type':'text/event-stream'}});
   };
   await import(${JSON.stringify(new URL('../scripts/managed-updater.mjs',import.meta.url).href)});`;
  currentChild=fork('--eval',[source],{execArgv:['--input-type=module'],stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,
   PATH:bin+':'+process.env.PATH,FIXTURE_CONFIG:config,FIXTURE_STATUS:statusFile,FIXTURE_BUSY:busy,FIXTURE_CALLS:calls,
   OPENCLAW_STATE_DIR:stateDir,OPENCLAW_CONFIG_PATH:path.join(stateDir,'openclaw.json')}});
  return currentChild;
 };
 const first=start(true);
 await until(()=>existsSync(path.join(directory,'pending-release.json')),first);
 assert.equal(existsSync(calls),false,'busy profile must not launch another worker');
 first.kill('SIGTERM');const [firstCode]=await once(first,'exit');assert.equal(firstCode,0);
 unlinkSync(busy);
 const second=start(false);
 await until(()=>existsSync(calls),second);
 second.kill('SIGTERM');const [secondCode]=await once(second,'exit');assert.equal(secondCode,0);
 const dispatched=readFileSync(calls,'utf8');
 assert.equal(dispatched.split('\n').filter(line=>line.endsWith('/scripts/openclaw-update-helper.mjs')).length,1);
 assert.ok(dispatched.includes('"revision":"resume-88"'));
 assert.ok(!dispatched.includes(credential.secret));
 assert.equal(readFileSync(installationFile,'utf8'),JSON.stringify(credential));
});
