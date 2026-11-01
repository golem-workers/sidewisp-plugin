import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {workerUnit} from '../src/update/worker.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const ctl=(...args)=>execFileSync('systemctl',['--user',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function until(check,timeout=100000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch{}await delay(200);}throw Error('TEST_CONDITION_TIMEOUT');}
for(const mode of ['manager-stop','preinstall-gateway-stop','worker-kill-accepted','worker-kill-commit'])test('real systemd interruption: '+mode,{skip:process.env.SIDEWISP_SYSTEMD_TEST!=='1',timeout:150000},async()=>{
 const r=mkdtempSync(path.join(os.tmpdir(),'sw-systemd-'));for(const n of ['bin','sidewisp','plugin'])mkdirSync(r+'/'+n);
 const manager='sw-test-manager-'+path.basename(r)+'.service',gateway='sw-test-gateway-'+path.basename(r)+'.service',worker=workerUnit(r);
 const read=n=>JSON.parse(readFileSync(r+'/'+n));const write=(n,v)=>writeFileSync(r+'/'+n,typeof v==='string'?v:JSON.stringify(v),{mode:0o600});
 const archive=Buffer.from('verified synthetic archive');writeFileSync(r+'/target.tgz',archive);write('plugin/package.json',{version:'0.2.82'});write('openclaw.json',{});write('queue','pending-data');write('sidewisp/installation.json',{status:'active',installationId:'sw_ins_fixture123',secret:'sw_secret_'+'a'.repeat(32)});write('live.json',{version:'0.2.82',installs:0});
 const directive={schema:'sidewisp.plugin-update.v1',targetVersion:'0.2.83',targetSpec:'git:github.com/golem-workers/sidewisp-plugin@v0.2.83',sha256:createHash('sha256').update(archive).digest('hex'),mandatory:true,revision:'systemd83',restartDelaySeconds:30,archivePath:r+'/target.tgz'};write('directive.json',directive);write('manager.json',{schema:'sidewisp.update-manager.v1',stateDir:r,endpoint:'https://example.test'});
 write('fetch.mjs',`import fs from 'node:fs';const r=${JSON.stringify(r)};globalThis.fetch=async(url,init)=>{if(fs.existsSync(r+'/offline'))throw Error('CONTROL_UNAVAILABLE');if(String(url).endsWith('update-heartbeat'))return{ok:true,json:async()=>({schema:'sidewisp.update-heartbeat.v1',installationId:'sw_ins_fixture123',update:null})};return{ok:true,headers:new Headers({'content-type':'text/event-stream'}),body:new ReadableStream({start(c){const update=fs.existsSync(r+'/delivered')?null:JSON.parse(fs.readFileSync(r+'/directive.json'));fs.writeFileSync(r+'/delivered','yes');c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({schema:'sidewisp.update-events.v1',installationId:'sw_ins_fixture123',update})+'\\n\\n'));init.signal.addEventListener('abort',()=>c.close(),{once:true});}})};};`);
 write('bin/openclaw',`#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto'),r=${JSON.stringify(r)},g=${JSON.stringify(gateway)},a=process.argv.slice(2),l=JSON.parse(fs.readFileSync(r+'/live.json'));
fs.appendFileSync(r+'/calls',a.slice(0,3).join(' ')+'\\n');
if(a[0]==='plugins'&&a[1]==='inspect')console.log(JSON.stringify({plugin:{rootDir:r+'/plugin'}}));
else if(a[0]==='plugins'&&a[1]==='install'){l.installs++;l.version='0.2.83';fs.writeFileSync(r+'/plugin/package.json',JSON.stringify({version:l.version}));fs.writeFileSync(r+'/live.json',JSON.stringify(l));fs.writeFileSync(r+'/committed','yes');if(${JSON.stringify(mode)}==='worker-kill-commit')while(!fs.existsSync(r+'/release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);console.log('{}');}
else if(a[0]==='plugins'&&a[1]==='reload')console.log('{}');
else if(a[2]==='sidewisp.status'){if(cp.spawnSync('systemctl',['--user','is-active','--quiet',g]).status!==0)process.exit(1);console.log(JSON.stringify({version:l.version,endpoint:'https://example.test',installation:{installationId:'sw_ins_fixture123'},enabled:true,running:true,connectionReadiness:{ready:true,stateId:crypto.createHash('sha256').update(fs.realpathSync(r)).digest('hex')}}));}
else if(a[2]==='diagnostics.lanes')console.log(JSON.stringify({ts:123,lanes:[{activeCount:0,queuedCount:0}],dynamic:null}));else process.exit(2);
`);chmodSync(r+'/bin/openclaw',0o700);
 const environment={HOME:process.env.HOME,PATH:r+'/bin:'+process.env.PATH,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR??'/run/user/0',DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS??'unix:path=/run/user/0/bus',OPENCLAW_STATE_DIR:r,OPENCLAW_CONFIG_PATH:r+'/openclaw.json'};
 const startManager=()=>execFileSync('systemd-run',['--user','--quiet','--collect','--unit='+manager,...Object.entries(environment).map(([k,v])=>'--setenv='+k+'='+v),'--',process.execPath,'--import',r+'/fetch.mjs',path.join(process.env.SIDEWISP_TEST_PACKAGE_ROOT??fileURLToPath(new URL('../',import.meta.url)),'scripts/managed-updater.mjs'),r+'/manager.json'],{stdio:'pipe'});
 const before=['sidewisp/installation.json','openclaw.json','queue'].map(n=>readFileSync(r+'/'+n));
 try{
 execFileSync('systemd-run',['--user','--quiet','--collect','--unit='+gateway,'--','/usr/bin/sleep','300'],{stdio:'pipe'});startManager();
 await until(()=>existsSync(r+'/sidewisp/current-update.json')&&read('sidewisp/current-update.json').phase==='accepted');
 const workerPid=ctl('show',worker,'-p','MainPID','--value');assert.notEqual(workerPid,'0');assert.notEqual(ctl('show',manager,'-p','ControlGroup','--value'),ctl('show',worker,'-p','ControlGroup','--value'));
 write('offline','yes');
 if(mode==='manager-stop'){ctl('stop',manager);assert.equal(ctl('show',worker,'-p','MainPID','--value'),workerPid);await until(()=>read('sidewisp/update-status.json').status==='completed');startManager();}
 if(mode==='preinstall-gateway-stop'){ctl('stop',gateway);await delay(32000);assert.notEqual(read('sidewisp/update-status.json').status,'failed');assert.equal(read('live.json').installs,0);execFileSync('systemd-run',['--user','--quiet','--collect','--unit='+gateway,'--','/usr/bin/sleep','300'],{stdio:'pipe'});}
 if(mode.startsWith('worker-kill')){
 if(mode==='worker-kill-commit')await until(()=>existsSync(r+'/committed'));
 ctl('stop',manager);ctl('kill','--kill-whom=all','--signal=KILL',worker);await until(()=>ctl('show',worker,'-p','MainPID','--value')==='0');
 assert.equal(read('sidewisp/current-update.json').phase,mode==='worker-kill-commit'?'install_intent':'accepted');write('release','yes');startManager();
 }
 await until(()=>read('sidewisp/update-status.json').status==='completed');assert.equal(read('live.json').installs,1);assert.equal(read('sidewisp/update-status.json').installCount,1);
 for(const [i,n]of ['sidewisp/installation.json','openclaw.json','queue'].entries())assert.deepEqual(readFileSync(r+'/'+n),before[i]);
 console.log(JSON.stringify({mode,actualFaultInjected:true,completed:true,installs:1,bindingAndQueuePreserved:true,separateCgroup:true,noNewDirective:true}));
 }finally{for(const u of [manager,worker,gateway])try{ctl('stop',u);}catch{}rmSync(r,{recursive:true,force:true});}
});
