import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { collectOpenClawContext } from '../src/context/openclaw.js';
import { collectRuntimeDiagnostics } from '../src/core/diagnostics.js';
const now=1800000000000;
test('SQLite context selects latest root, ignores child/archive; numeric privacy contract survives',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sw-context-'));
 const dir=path.join(root,'agents','private-agent','agent');await fs.mkdir(dir,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'openclaw-agent.sqlite'));
 try{
 db.exec('CREATE TABLE session_nodes(entry_json TEXT,updated_at INTEGER,entry_valid INTEGER,archived_at INTEGER,parent_session_key TEXT)');
 const add=(used,at,parent=null,archive=null,fresh=true)=>db.prepare('INSERT INTO session_nodes VALUES(?,?,1,?,?)').run(JSON.stringify({totalTokens:used,contextTokens:258000,totalTokensFresh:fresh,prompt:'PRIVATE',inputTokens:9000000}),at,archive,parent);
 add(99000,now-1000);add(250000,now,'child');add(258000,now,null,now);
 let facts=await collectOpenClawContext({stateDir:root,now:()=>now});
 assert.equal(facts.find(x=>x.key==='context.used').value,99000);
 const snapshot=await collectRuntimeDiagnostics({installationId:'sw_ins_fixture',runtimeKind:'openclaw',runtimeVersion:'1',adapterName:'sidewisp',adapterVersion:'1',now:()=>now,probes:{runtime:async()=>({outcome:'ok',facts})}});
 assert.equal(snapshot.sections[0].facts.length,4);assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE|private-agent|9000000/);
 add(123,now,null,null,false);assert.deepEqual(await collectOpenClawContext({stateDir:root,now:()=>now}),[]);
 }finally{db.close();await fs.rm(root,{recursive:true,force:true})}
});
test('legacy index keeps zero distinct from missing, rejects stale and future',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sw-context-'));const dir=path.join(root,'agents','main','sessions');await fs.mkdir(dir,{recursive:true});
 try{
 for(const [entry,expected] of [[{totalTokens:0,contextTokens:100,updatedAt:now},4],[{contextTokens:100,updatedAt:now},0],[{totalTokens:2,contextTokens:100,updatedAt:now-900001},0],[{totalTokens:2,contextTokens:100,updatedAt:now+1},0]]){
 await fs.writeFile(path.join(dir,'sessions.json'),JSON.stringify({root:entry}));assert.equal((await collectOpenClawContext({stateDir:root,now:()=>now})).length,expected);
 }
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
