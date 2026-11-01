import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { collectOpenClawCron } from '../src/cron/openclaw.js';
const job = {id:'job1', name:'SQLite real inventory', enabled:true, schedule:{kind:'every',everyMs:120000},payload:{kind:'agentTurn',message:'SECRET_PROMPT'},state:{lastStatus:'error'}};
async function fixture(t) {
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sw-cron-sqlite-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 await mkdir(path.join(stateDir,'state'));await mkdir(path.join(stateDir,'cron'));
 const db=new DatabaseSync(path.join(stateDir,'state/openclaw.sqlite'));t.after(()=>db.close());
 db.exec("PRAGMA journal_mode=WAL; CREATE TABLE cron_jobs (store_key TEXT,job_id TEXT,enabled INTEGER,job_json TEXT,state_json TEXT,PRIMARY KEY(store_key,job_id));");
 const store=path.join(stateDir,'cron/jobs.json');
 const add=(id,key=store,state={lastRunAtMs:123,lastRunStatus:'ok'})=>db.prepare('INSERT INTO cron_jobs VALUES(?,?,?,?,?)').run(key,id,0,JSON.stringify(job),JSON.stringify(state));
 return {stateDir,db,store,add};
}
test('SQLite/WAL is authoritative, partition-scoped, read-only and includes runtime state not stale definition state',async t=>{
 const f=await fixture(t);f.add('real');f.add('foreign','/other/cron/jobs.json');await writeFile(f.store,JSON.stringify({jobs:[{...job,id:'STALE'}]}));
 const before=await readFile(path.join(f.stateDir,'state/openclaw.sqlite'));
 const result=await collectOpenClawCron(f);assert.equal(result.status,'ok');assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].id,'real');assert.equal(result.jobs[0].enabled,false);assert.equal(result.jobs[0].lastRunAtMs,123);assert.equal(result.jobs[0].lastStatus,'ok');assert.doesNotMatch(JSON.stringify(result),/SECRET_PROMPT|STALE|foreign/);
 assert.deepEqual(await readFile(path.join(f.stateDir,'state/openclaw.sqlite')),before);
 f.db.prepare('UPDATE cron_jobs SET state_json=? WHERE job_id=?').run(JSON.stringify({lastRunAtMs:456,lastRunStatus:'error'}),'real');assert.equal((await collectOpenClawCron(f)).jobs[0].lastRunAtMs,456);
});
test('missing SQLite preserves JSON support without creating state database',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'sw-cron-json-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));await mkdir(path.join(stateDir,'cron'));await writeFile(path.join(stateDir,'cron/jobs.json'),JSON.stringify({jobs:[job]}));
 assert.equal((await collectOpenClawCron({stateDir})).status,'ok');await assert.rejects(readFile(path.join(stateDir,'state/openclaw.sqlite')),{code:'ENOENT'});
});
test('custom partition and empty authoritative inventory do not read stale default JSON',async t=>{
 const f=await fixture(t);f.add('custom','/custom/partition');assert.equal((await collectOpenClawCron({...f,storePath:'/custom/partition'})).jobs[0].id,'custom');assert.deepEqual(await collectOpenClawCron(f),{status:'ok',jobs:[]});
});
test('corrupt SQLite rows, absent schema and oversized partition fail closed rather than falling back',async t=>{
 const f=await fixture(t);f.add('bad');await writeFile(f.store,JSON.stringify({jobs:[job]}));f.db.exec("UPDATE cron_jobs SET state_json='broken'");assert.equal((await collectOpenClawCron(f)).status,'unavailable');f.db.exec('DROP TABLE cron_jobs');assert.equal((await collectOpenClawCron(f)).status,'unavailable');
});
test('bounded SQLite inventory rejects more than 1000 rows',async t=>{
 const f=await fixture(t);f.db.exec('BEGIN');for(let i=0;i<1001;i++)f.add('row'+i);f.db.exec('COMMIT');assert.equal((await collectOpenClawCron(f)).status,'unavailable');
});
