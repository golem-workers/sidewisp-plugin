import path from 'node:path';
import {existsSync} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sanitizeTelemetryEvent } from '../core/sanitize.js';
const SOURCE='openclaw-native-cron-delivery-v1';
const session=/^agent:[^:]+:cron:([^:]+):run:([^:]+)$/;
// Read only the native automation receipt projection, never task prompts,
// delivery targets, credentials, or transcript bodies. SQLite is authoritative.
export function collectNativeCronDeliveryReceipts({stateDir,storePath=path.join(stateDir,'cron/jobs.json'),installationId,spool,envelopeFactory,now=Date.now}) {
 let db;
 try {
  if(!existsSync(path.join(stateDir,'state/openclaw.sqlite')))return {status:'unsupported',events:0};
  db=new DatabaseSync(path.join(stateDir,'state/openclaw.sqlite'),{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_runs'").get())return {status:'unsupported',events:0};
  const saved=spool.cursor(SOURCE);let cursor=saved?JSON.parse(saved):null;
  if(!cursor||cursor.installationId!==installationId){spool.advanceCursor(SOURCE,JSON.stringify({atMs:now(),id:'',installationId}));return {status:'baseline',events:0};}
  if(!Number.isSafeInteger(cursor.atMs)||typeof cursor.id!=='string')throw Error('invalid_native_cron_cursor');
  const rows=db.prepare(`SELECT task_id,source_id,child_session_key,status,ended_at,terminal_summary,detail_json FROM task_runs WHERE runtime='cron' AND task_kind='automation_run' AND ended_at IS NOT NULL AND (ended_at>? OR (ended_at=? AND task_id>?)) ORDER BY ended_at,task_id LIMIT 100`).all(cursor.atMs,cursor.atMs,cursor.id);
  const events=[];
  for(const row of rows) {
   if(!Number.isSafeInteger(row.ended_at)||row.ended_at>now())break;
   cursor={atMs:row.ended_at,id:row.task_id,installationId};
   const key=session.exec(row.child_session_key??'');
   if(!key||key[1]!==row.source_id||row.status!=='succeeded'||typeof row.detail_json!=='string'||Buffer.byteLength(row.detail_json)>65536)continue;
   let receipt;try{receipt=JSON.parse(row.detail_json);}catch{continue;}
   if(receipt.kind!=='cron-run'||receipt.status!=='ok'||receipt.completionStatus!=='succeeded'||receipt.delivered!==true||receipt.deliveryStatus!=='delivered'||receipt.storeKey!==path.resolve(storePath)||receipt.sessionId!==key[2])continue;
   const envelope=envelopeFactory(row.task_id);
   events.push(sanitizeTelemetryEvent({...envelope,occurredAt:new Date(row.ended_at).toISOString(),runtime:{...envelope.runtime,kind:'openclaw'},type:'message.delivered',outcome:'success',correlation:{sessionId:row.child_session_key,messageId:row.task_id},details:{component:'native_cron_delivery_receipt',status:'delivered'},messagePreview:row.terminal_summary}));
  }
  if(rows.length)spool.enqueueSourceBatch(SOURCE,JSON.stringify(cursor),events);
  return {status:'ok',events:events.length};
 }catch(error){if(error.code==='ENOENT'||error.code==='ERR_SQLITE_CANTOPEN')return {status:'unsupported',events:0};throw error;}
 finally{db?.close();}
}
