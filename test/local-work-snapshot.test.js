import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalWorkSnapshotRequest } from '../src/adapters/openclaw/local-work-snapshot.js';
import { createOpenClawWorkReconciliation } from '../src/adapters/openclaw/work-reconciliation.js';
const key = 'agent:main:telegram:group:test';
const work = {kind:'task',sessionId:key,messageId:'1',turnId:'1',started:true,internalRunIds:['run']};
const done = {status:'done',startedAt:20,endedAt:90,lastRunId:'run',activeWriterRunId:'run'};
function fixture(t, entry = done) {
 const stateDir = fs.mkdtempSync(path.join(os.tmpdir(),'sw-local-work-'));
 t.after(()=>fs.rmSync(stateDir,{recursive:true,force:true}));
 const root = path.join(stateDir,'agents/main/agent');fs.mkdirSync(root,{recursive:true});
 const db = new DatabaseSync(path.join(root,'openclaw-agent.sqlite'));
 db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY, entry_json TEXT, entry_valid INTEGER, archived_at INTEGER)');
 db.prepare('INSERT INTO session_nodes VALUES(?,?,1,NULL)').run(key,JSON.stringify(entry));db.close();
 const request = createLocalWorkSnapshotRequest({stateDir,activeWork:()=>[work],now:()=>100});
 return {stateDir,request};
}
test('real local SQLite terminal metadata closes exact task without trusted Gateway API',async t=>{
 const {request}=fixture(t);const emitted=[];
 const r=createOpenClawWorkReconciliation({request,activeWork:()=>[work],now:()=>100,emit:async input=>{emitted.push(input);return true;}});
 assert.equal((await r.reconcile()).reconciled,1);assert.equal(emitted[0].outcome,'success');
});
test('active, waiting, missing terminal markers, stale writer, future or inconsistent ends are not terminal',async t=>{
 for(const entry of [{...done,status:'running'},{...done,status:'waiting'},{...done,endedAt:undefined},
  {...done,activeWriterRunId:'new-run'},{...done,endedAt:101},{...done,startedAt:91}, {...done,lastRunId:undefined}]) {
  const {request}=fixture(t,entry);const result=await request('sessions.list');assert.equal(result.sessions[0].hasActiveRun,true);
 }
});
test('newly admitted task cannot be closed by previously completed run',async t=>{
 const {request}=fixture(t,{...done,lastRunId:'previous',activeWriterRunId:'previous'});const emitted=[];
 const r=createOpenClawWorkReconciliation({request,activeWork:()=>[work],now:()=>100,emit:async x=>{emitted.push(x);return true;}});
 assert.equal((await r.reconcile()).reconciled,0);assert.deepEqual(emitted,[]);
});
test('legacy index is read only and never exports content fields',async t=>{
 const {stateDir}=fixture(t);fs.unlinkSync(path.join(stateDir,'agents/main/agent/openclaw-agent.sqlite'));
 const root=path.join(stateDir,'agents/main/sessions');fs.mkdirSync(root,{recursive:true});
 const file=path.join(root,'sessions.json');const text=JSON.stringify({[key]:{...done,prompt:'private text',displayName:'private name'}});fs.writeFileSync(file,text);
 const request=createLocalWorkSnapshotRequest({stateDir,activeWork:()=>[work],now:()=>100});
 const result=await request('sessions.list');assert.equal(result.sessions[0].hasActiveRun,false);
 assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(fs.readFileSync(file,'utf8'),text);
 fs.unlinkSync(file);assert.deepEqual((await request('sessions.list')).sessions,[]);
});
