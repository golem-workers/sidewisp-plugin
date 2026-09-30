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
