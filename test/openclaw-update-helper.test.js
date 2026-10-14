import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {safeUpdateFailure} from '../src/update/failure.js';
const helper=fileURLToPath(new URL('../scripts/openclaw-update-helper.mjs',import.meta.url));
function fixture(t,mode='repair') {
 const r=mkdtempSync(path.join(os.tmpdir(),'sw-current-'));t.after(()=>rmSync(r,{recursive:true,force:true}));mkdirSync(r+'/bin');mkdirSync(r+'/plugin');mkdirSync(r+'/sidewisp');
 writeFileSync(r+'/plugin/package.json',JSON.stringify({version:'0.2.48'}));writeFileSync(r+'/openclaw.json','{}');
 writeFileSync(r+'/sidewisp/installation.json',JSON.stringify({status:'active',installationId:'sw_ins_fixture123',secret:'private-fixture'}));
 writeFileSync(r+'/queue','unsent-work-do-not-delete');writeFileSync(r+'/live.json',JSON.stringify({version:'0.2.48',ready:true,installs:0}));
 writeFileSync(r+'/skip.mjs','globalThis.setTimeout=fn=>{queueMicrotask(fn);};');const bytes=Buffer.from('exact verified target');writeFileSync(r+'/target.tgz',bytes);
 writeFileSync(r+'/bin/openclaw',`#!/usr/bin/env node
const fs=require('fs'),r=process.env.TEST_ROOT,a=process.argv.slice(2),f=r+'/live.json',l=JSON.parse(fs.readFileSync(f));fs.appendFileSync(r+'/calls',a.join(' ')+'\\n');
if(a[0]==='plugins'&&a[1]==='inspect')console.log(JSON.stringify({plugin:{rootDir:r+'/plugin'}}));
else if(a[0]==='plugins'&&a[1]==='install') {
 if(process.env.MODE==='deny')process.exit(1);
 l.installs++;l.version='0.2.52';l.ready=process.env.MODE==='repair'?l.installs>=2:process.env.MODE!=='broken';
 fs.writeFileSync(r+'/plugin/package.json',JSON.stringify({version:l.version}));fs.writeFileSync(f,JSON.stringify(l));
 if(process.env.MODE==='crash'&&!fs.existsSync(r+'/crashed')) {fs.writeFileSync(r+'/crashed','yes');process.kill(Number(process.env.HELPER_TEST_PID),'SIGKILL');}
 console.log('{}');
} else if(a[2]==='diagnostics.lanes')console.log(JSON.stringify({ts:123,lanes:[{activeCount:process.env.MODE==='busy'?1:0,queuedCount:0}],dynamic:null}));
else if(a[2]==='sidewisp.status')console.log(JSON.stringify({version:l.version,endpoint:'https://example.test',installation:{installationId:'sw_ins_fixture123'},enabled:true,running:l.ready,connectionReadiness:{ready:l.ready,stateId:require('crypto').createHash('sha256').update(fs.realpathSync(r)).digest('hex')}}));
else if(a[0]==='plugins'&&a[1]==='reload')console.log('{}');else process.exit(2);
`,{mode:0o700});
 // Worker PID is available only to this deliberately hostile test CLI.
 writeFileSync(r+'/pid.mjs',"process.env.HELPER_TEST_PID=String(process.pid);");
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.52',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.52',sha256:createHash('sha256').update(bytes).digest('hex'),restartDelaySeconds:30,stateFile:r+'/sidewisp/update.json',archivePath:r+'/target.tgz',revision:'fixture52'};
 const env={...process.env,OPENCLAW_STATE_DIR:r,OPENCLAW_CONFIG_PATH:r+'/openclaw.json',TEST_ROOT:r,MODE:mode,PATH:r+'/bin:'+process.env.PATH};
 return {r,d,run:()=>execFileSync(process.execPath,['--import',r+'/skip.mjs','--import',r+'/pid.mjs',helper,JSON.stringify(d)],{env,stdio:'pipe',timeout:120000}),state:()=>JSON.parse(readFileSync(d.stateFile)),calls:()=>readFileSync(r+'/calls','utf8')};
}
test('corrupted archive is refused before any mutation or restart',t=>{const f=fixture(t);f.d.sha256='a'.repeat(64);assert.throws(f.run);assert.equal(f.state().errorCode,'ARTIFACT_HASH_MISMATCH');assert.doesNotMatch(f.calls(),/plugins install|plugins reload|gateway restart/);});
test('failed startup repairs only the same current version and preserves binding, config and queue',t=>{const f=fixture(t);const before=['sidewisp/installation.json','openclaw.json','queue'].map(n=>readFileSync(f.r+'/'+n));f.run();assert.equal(f.state().status,'completed');assert.equal(f.state().installCount,2);assert.equal(f.calls().match(/plugins install/g).length,2);assert.doesNotMatch(f.calls(),/rollback|gateway restart/);for(const [i,n] of ['sidewisp/installation.json','openclaw.json','queue'].entries())assert.deepEqual(readFileSync(f.r+'/'+n),before[i]);});
test('a broken release is bounded and never downgrades or retries a terminal revision',t=>{const f=fixture(t,'broken');assert.throws(f.run);assert.equal(f.state().errorCode,'CURRENT_RELEASE_UNHEALTHY');assert.equal(f.state().installCount,2);const calls=f.calls();f.run();assert.equal(f.calls(),calls);assert.doesNotMatch(calls,/rollback|gateway restart/);});
test('host policy denial never activates, repairs or changes credentials',t=>{const f=fixture(t,'deny');assert.throws(f.run);assert.equal(f.state().status,'failed');assert.equal(f.calls().match(/plugins install/g).length,1);assert.doesNotMatch(f.calls(),/plugins reload|gateway restart/);});
test('busy host defers with zero installs and persisted target',t=>{const f=fixture(t,'busy');f.run();assert.equal(f.state().status,'deferred');assert.doesNotMatch(f.calls(),/plugins install|plugins reload|gateway restart/);assert.equal(JSON.parse(readFileSync(f.r+'/sidewisp/current-update.json')).directive.targetVersion,'0.2.52');});
test('real SIGKILL after package commit releases kernel lock and resumes without another installation',t=>{const f=fixture(t,'crash');assert.throws(f.run);assert.ok(existsSync(f.r+'/crashed'));assert.equal(JSON.parse(readFileSync(f.r+'/sidewisp/current-update.json')).phase,'install_intent');f.run();assert.equal(f.state().status,'completed');assert.equal(f.calls().match(/plugins install/g).length,1);});
test('diagnosis excludes private exception details',()=>{assert.equal(safeUpdateFailure(Error('CURRENT_RELEASE_UNHEALTHY')),'CURRENT_RELEASE_UNHEALTHY');assert.equal(safeUpdateFailure(Error('private-token /home/x')),'INSTALL_OR_RELOAD_REFUSED');});
