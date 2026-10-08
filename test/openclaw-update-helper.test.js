import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
const helper=fileURLToPath(new URL('../scripts/openclaw-update-helper.mjs',import.meta.url));
test('a bad archive never reaches install, rollback or Gateway restart',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'sidewisp-safe-helper-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(path.join(root,'bin'));mkdirSync(path.join(root,'plugin'));writeFileSync(path.join(root,'plugin/package.json'),JSON.stringify({version:'0.2.34'}));
 writeFileSync(path.join(root,'bad.tgz'),'tampered');writeFileSync(path.join(root,'skip.mjs'),'globalThis.setTimeout=fn=>{queueMicrotask(fn);};');
 writeFileSync(path.join(root,'bin/openclaw'),`#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(process.env.TEST_ROOT+'/calls',process.argv.slice(2).join(' ')+'\\n');if(process.argv[2]==='gateway')console.log(JSON.stringify({version:'0.2.34'}));else console.log(JSON.stringify({plugin:{rootDir:process.env.TEST_ROOT+'/plugin'}}));`,{mode:0o700});
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.35',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.35',sha256:'a'.repeat(64),restartDelaySeconds:30,stateFile:path.join(root,'update.json'),archivePath:path.join(root,'bad.tgz')};
 assert.throws(()=>execFileSync(process.execPath,['--import',path.join(root,'skip.mjs'),helper,JSON.stringify(d)],{env:{...process.env,TEST_ROOT:root,PATH:path.join(root,'bin')+':'+process.env.PATH},stdio:'pipe'}));
 assert.equal(JSON.parse(readFileSync(d.stateFile)).errorCode,'ARTIFACT_HASH_MISMATCH');
 assert.doesNotMatch(readFileSync(path.join(root,'calls'),'utf8'),/plugins install|plugins reload|gateway restart/);
});

import {createHash} from 'node:crypto';
import {safeUpdateFailure} from '../src/update/failure.js';
test('private or unknown errors cannot be promoted into public diagnosis',()=>{
 assert.equal(safeUpdateFailure(Error('TARGET_COLLECTOR_UNHEALTHY')),'TARGET_COLLECTOR_UNHEALTHY');
 for(const message of ['SECRET_TOKEN_VALUE','provider response /private/path','credentials=private'])assert.equal(safeUpdateFailure(Error(message)),'INSTALL_OR_RELOAD_REFUSED');
});
test('actual unhealthy-target failure survives successful rollback; binding and credentials stay intact',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'sidewisp-rollback-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(path.join(root,'bin'));mkdirSync(path.join(root,'plugin'));writeFileSync(path.join(root,'plugin/package.json'),JSON.stringify({version:'0.2.34'}));
 const credential='{"installationId":"sw_ins_fixture123","secret":"private-fixture"}';writeFileSync(path.join(root,'installation.json'),credential);
 const bytes=Buffer.from('verified local target fixture');writeFileSync(path.join(root,'target.tgz'),bytes);writeFileSync(path.join(root,'skip.mjs'),'globalThis.setTimeout=fn=>{queueMicrotask(fn);};');
 writeFileSync(path.join(root,'live.json'),JSON.stringify({version:'0.2.34'}));
 writeFileSync(path.join(root,'bin/openclaw'),`#!/usr/bin/env node
const fs=require('fs'),r=process.env.TEST_ROOT,args=process.argv.slice(2),file=r+'/live.json';fs.appendFileSync(r+'/calls',args.join(' ')+'\\n');const live=JSON.parse(fs.readFileSync(file));
if(args[0]==='plugins'&&args[1]==='inspect')console.log(JSON.stringify({plugin:{rootDir:r+'/plugin'}}));
else if(args[0]==='plugins'&&args[1]==='install'){const version=args[2].endsWith('.tgz')?'0.2.35':'0.2.34';fs.writeFileSync(file,JSON.stringify({version}));fs.writeFileSync(r+'/plugin/package.json',JSON.stringify({version}));console.log('{}');}
else if(args[2]==='diagnostics.lanes')console.log(JSON.stringify({ts:123,lanes:[{activeCount:0,queuedCount:0}],dynamic:null}));
else if(args[2]==='sidewisp.status')console.log(JSON.stringify({...live,endpoint:'https://example.test',installation:{installationId:'sw_ins_fixture123'},enabled:true,running:live.version==='0.2.34',connectionReadiness:{ready:live.version==='0.2.34'}}));
else if(args[0]==='plugins'&&args[1]==='reload')console.log('{}');else process.exit(2);
`,{mode:0o700});
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.35',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.35',sha256:createHash('sha256').update(bytes).digest('hex'),restartDelaySeconds:30,stateFile:path.join(root,'update.json'),archivePath:path.join(root,'target.tgz')};
 assert.throws(()=>execFileSync(process.execPath,['--import',path.join(root,'skip.mjs'),helper,JSON.stringify(d)],{env:{...process.env,TEST_ROOT:root,PATH:path.join(root,'bin')+':'+process.env.PATH},stdio:'pipe'}));
 const state=JSON.parse(readFileSync(d.stateFile));assert.equal(state.status,'rolled_back');assert.equal(state.errorCode,'TARGET_COLLECTOR_UNHEALTHY');assert.equal(state.targetVersion,d.targetVersion);
 assert.equal(JSON.parse(readFileSync(path.join(root,'live.json'))).version,'0.2.34');assert.equal(readFileSync(path.join(root,'installation.json'),'utf8'),credential);
 const calls=readFileSync(path.join(root,'calls'),'utf8');assert.equal(calls.match(/plugins install/g)?.length,2);assert.doesNotMatch(calls,/gateway restart/);
});


test('rollback of an activation-required source uses the same verified idle cold activation and preserves the original cause',t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'sidewisp-cold-rollback-proof-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(path.join(root,'bin'));mkdirSync(path.join(root,'plugin'));writeFileSync(path.join(root,'plugin/package.json'),JSON.stringify({version:'0.2.48'}));
 writeFileSync(path.join(root,'openclaw.json'),'{}');const credential='{"installationId":"sw_ins_fixture123","secret":"private-fixture"}';writeFileSync(path.join(root,'installation.json'),credential);
 const bytes=Buffer.from('verified local target fixture');writeFileSync(path.join(root,'target.tgz'),bytes);writeFileSync(path.join(root,'skip.mjs'),'globalThis.setTimeout=fn=>{queueMicrotask(fn);};');
 const fake=`#!/usr/bin/env node
const fs=require('fs'),r=process.env.TEST_ROOT,args=process.argv.slice(2),file=r+'/live.json';fs.appendFileSync(r+'/calls',args.join(' ')+'\\n');const live=JSON.parse(fs.readFileSync(file));
if(args[0]==='plugins'&&args[1]==='inspect')console.log(JSON.stringify({plugin:{rootDir:r+'/plugin'}}));
else if(args[0]==='plugins'&&args[1]==='install'){const version=args[2].endsWith('.tgz')?'0.2.51':'0.2.48';fs.writeFileSync(file,JSON.stringify({version,activationRequired:version==='0.2.48'}));fs.writeFileSync(r+'/plugin/package.json',JSON.stringify({version}));console.log('{}');}
else if(args[2]==='diagnostics.lanes')console.log(JSON.stringify({ts:123,lanes:[{activeCount:0,queuedCount:0}],dynamic:null}));
else if(args[2]==='sidewisp.status')console.log(JSON.stringify({...live,endpoint:'https://example.test',installation:{installationId:'sw_ins_fixture123'},enabled:true,running:true,connectionReadiness:{ready:live.version==='0.2.48'&&!live.activationRequired,activationRequired:live.activationRequired}}));
else if(args[0]==='plugins'&&args[1]==='reload')console.log('{}');
else if(args[0]==='gateway'&&args[1]==='status')console.log(JSON.stringify({service:{loaded:true,runtime:{status:'running',pid:123},command:{environment:{OPENCLAW_STATE_DIR:r,OPENCLAW_CONFIG_PATH:r+'/openclaw.json'}}},config:{daemon:{path:r+'/openclaw.json'},mismatch:false}}));
else if(args[0]==='gateway'&&args[1]==='suspend')console.log(JSON.stringify(process.env.DENY_COLD==='yes'?{status:'busy'}:{status:'ready',suspensionId:'fixture-lease'}));
else if(args[0]==='gateway'&&args[1]==='restart'){fs.writeFileSync(file,JSON.stringify({...live,activationRequired:false}));console.log('{}');}
else process.exit(2);
`;
 writeFileSync(path.join(root,'bin/openclaw'),fake,{mode:0o700});
 const d={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.51',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.51',sha256:createHash('sha256').update(bytes).digest('hex'),restartDelaySeconds:30,stateFile:path.join(root,'update.json'),archivePath:path.join(root,'target.tgz')};
 const execute=deny=>{writeFileSync(path.join(root,'live.json'),JSON.stringify({version:'0.2.48',activationRequired:false}));writeFileSync(path.join(root,'plugin/package.json'),JSON.stringify({version:'0.2.48'}));writeFileSync(path.join(root,'calls'),'');assert.throws(()=>execFileSync(process.execPath,['--import',path.join(root,'skip.mjs'),helper,JSON.stringify(d)],{env:{...process.env,TEST_ROOT:root,PATH:path.join(root,'bin')+':'+process.env.PATH,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json'),DENY_COLD:deny?'yes':'no'},stdio:'pipe'}));return JSON.parse(readFileSync(d.stateFile));};
 const success=execute(false);assert.equal(success.status,'rolled_back');assert.equal(success.errorCode,'TARGET_COLLECTOR_UNHEALTHY');assert.equal(JSON.parse(readFileSync(path.join(root,'live.json'))).activationRequired,false);assert.equal(readFileSync(path.join(root,'installation.json'),'utf8'),credential);
 const calls=readFileSync(path.join(root,'calls'),'utf8');assert.equal(calls.match(/gateway restart/g)?.length,1);assert.ok(calls.indexOf('gateway suspend')<calls.indexOf('gateway restart'));assert.doesNotMatch(calls,/--force.*gateway|gateway restart.*--force/);
 // A busy host never restarts. The original target failure survives this recovery failure too.
 const denied=execute(true);assert.notEqual(denied.status,'rolled_back');assert.equal(denied.errorCode,'TARGET_COLLECTOR_UNHEALTHY');assert.doesNotMatch(readFileSync(path.join(root,'calls'),'utf8'),/gateway restart/);
});
