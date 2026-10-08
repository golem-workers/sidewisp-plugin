import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync,unlinkSync,symlinkSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installUpdateManager} from '../scripts/install-update-manager.mjs';
function fixture(t){const root=mkdtempSync(path.join(os.tmpdir(),'manager-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const calls=[];const options={stateDir:root,endpoint:'https://example.test',platform:'linux',environment:{HOME:root,PATH:'/usr/bin',OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:path.join(root,'openclaw.json')},run:(...args)=>calls.push(args)};return {root,calls,options};}
test('repeated preparation preserves owner unit and config additions',t=>{const f=fixture(t);const result=installUpdateManager(f.options);const unit=path.join(f.root,'.config/systemd/user',result.unit);const customized=readFileSync(unit,'utf8')+'\n# owner policy\n[Service]\nMemoryMax=512M\n';writeFileSync(unit,customized);const config=JSON.parse(readFileSync(result.configFile));config.ownerSetting=true;writeFileSync(result.configFile,JSON.stringify(config));installUpdateManager(f.options);assert.equal(readFileSync(unit,'utf8'),customized);assert.equal(JSON.parse(readFileSync(result.configFile)).ownerSetting,true);});
test('changed manager entry point fails closed without replacing unit',t=>{const f=fixture(t);const result=installUpdateManager(f.options);const unit=path.join(f.root,'.config/systemd/user',result.unit);const customized=readFileSync(unit,'utf8').replace(/^ExecStart=.*$/m,'ExecStart=/owner/custom-manager');writeFileSync(unit,customized);f.calls.length=0;assert.throws(()=>installUpdateManager(f.options),/MANAGER_UNIT_REVIEW_REQUIRED/);assert.equal(readFileSync(unit,'utf8'),customized);assert.equal(f.calls.length,0);});

function oldManager(f,result){const current=path.join(f.root,'sidewisp/manager/current');const old=path.join(f.root,'sidewisp/manager/releases/0.2.38');mkdirSync(old,{recursive:true});writeFileSync(path.join(old,'package.json'),JSON.stringify({version:'0.2.38'}));unlinkSync(current);symlinkSync(old,current);return {current,old,unit:path.join(f.root,'.config/systemd/user',result.unit)};}
test('explicit manager upgrade switches only private code and preserves owner config/unit',t=>{
 const f=fixture(t);const result=installUpdateManager(f.options);const prior=oldManager(f,result);
 const unit=readFileSync(prior.unit,'utf8')+'\n# owner override\n';writeFileSync(prior.unit,unit);const config=readFileSync(result.configFile,'utf8');f.calls.length=0;
 const after=installUpdateManager({...f.options,upgrade:true});assert.equal(after.managerVersion,'0.2.48');assert.notEqual(realpathSync(prior.current),prior.old);
 assert.equal(readFileSync(prior.unit,'utf8'),unit);assert.equal(readFileSync(result.configFile,'utf8'),config);
 assert.deepEqual(f.calls.map(c=>c[1]),[['--user','stop',result.unit],['--user','daemon-reload'],['--user','enable','--now',result.unit]]);
});
test('ordinary preparation does not silently upgrade an existing manager',t=>{
 const f=fixture(t);const result=installUpdateManager(f.options);const prior=oldManager(f,result);f.calls.length=0;
 const after=installUpdateManager(f.options);assert.equal(after.managerVersion,'0.2.38');assert.equal(realpathSync(prior.current),prior.old);assert.equal(f.calls.some(c=>c[1].includes('stop')),false);
});
test('active update helper blocks manager upgrade before any system call or link change',t=>{
 const f=fixture(t);const result=installUpdateManager(f.options);const prior=oldManager(f,result);writeFileSync(path.join(f.root,'sidewisp/update-status.json.lock'),'active');f.calls.length=0;
 assert.throws(()=>installUpdateManager({...f.options,upgrade:true}),/MANAGER_UPDATE_IN_PROGRESS/);assert.equal(realpathSync(prior.current),prior.old);assert.equal(f.calls.length,0);
});

test('failed new-manager activation restores the old private code without touching Gateway',t=>{
 const f=fixture(t);const result=installUpdateManager(f.options);const prior=oldManager(f,result);const calls=[];
 assert.throws(()=>installUpdateManager({...f.options,upgrade:true,run:(cmd,args)=>{calls.push(args);if(args.includes('enable'))throw Error('activation refused');}}),/activation refused/);
 assert.equal(realpathSync(prior.current),prior.old);assert.deepEqual(calls.at(-1),['--user','start',result.unit]);assert.equal(calls.some(c=>c.some(a=>String(a).includes('gateway'))),false);
});
