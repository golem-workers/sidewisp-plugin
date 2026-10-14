// Product bootstrap: ship the corrected platform helper with the verified plugin.
// Existing custom workspace files are never replaced. No binding, cron or prefs writes.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, mkdir, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pins = {
 'cron-helper/cron-helper.sh': { source:'cron-helper.sh', mode:0o755, current:'7989fc94c23f59c8441205b64c144e1de54462db72ba3d3aaa19cfe168cceb9c', previous:['a165a012664adb6c81051311b20417aed9947d4d2556da7d5c58e3525f77c6b3'] },
 'skills/native-openclaw-cron/SKILL.md': { source:'SKILL.md', mode:0o644, current:'347a4632d1e4b3695a8a9e20e1deaf36a895be044600f7a24705a91baacb9d0e', previous:[] },
};
async function regular(file) {
 try { const st = await lstat(file); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw Error('native_cron_nonregular_target'); return await readFile(file); }
 catch (e) { if(e.code === 'ENOENT') return null; throw e; }
}
async function directory(dir) {
 try { const st = await lstat(dir); if(!st.isDirectory() || st.isSymbolicLink()) throw Error('native_cron_nonregular_directory'); }
 catch(e) { if(e.code !== 'ENOENT') throw e; try { await mkdir(dir, {mode:0o755}); } catch(race) { if(race.code !== 'EEXIST') throw race; const st=await lstat(dir); if(!st.isDirectory() || st.isSymbolicLink()) throw Error('native_cron_nonregular_directory'); } }
}
// The provisioned shared helper predates per-agent workspace subdivision.
// Upgrade its configured base as well as the SDK-resolved model workspaces.
export function nativeCronWorkspaces({ config, resolvedWorkspaces, home = os.homedir() }) {
 const base = config?.agents?.defaults?.workspace;
 const expanded = typeof base === 'string' && base.startsWith('~/') ? path.join(home, base.slice(2)) : base;
 return [...new Set([...(typeof expanded === 'string' && path.isAbsolute(expanded) ? [expanded] : []), ...resolvedWorkspaces])];
}
export async function ensureNativeCronHelper({endpoint, workspaces}) {
 // Production defaults and existing production collectors stay byte-identical.
 if(endpoint !== 'https://staging-api.sidewisp.com') return {status:'out_of_scope', files:[]};
 if(!Array.isArray(workspaces) || !workspaces.length || workspaces.some(p => !path.isAbsolute(p))) throw Error('native_cron_workspace_required');
 const files=[];
 for(const workspace of new Set(workspaces)) {
  // The host owns workspace resolution; do not guess another profile's workspace.
  await directory(workspace);
  for(const [relative,pin] of Object.entries(pins)) {
   const source=await readFile(new URL('./native-cron/'+pin.source,import.meta.url));
   if(hash(source) !== pin.current) throw Error('native_cron_source_mismatch');
   const dirs=relative.split('/').slice(0,-1);let dir=workspace;
   for(const part of dirs) {dir=path.join(dir,part);await directory(dir);}
   const target=path.join(workspace,relative), original=await regular(target);
   if(original && hash(original) !== pin.current && !pin.previous.includes(hash(original))) {
    files.push({workspace,file:relative,status:'custom_preserved'}); continue;
   }
   if(original && hash(original) === pin.current) {
    if(pin.mode === 0o755) await chmod(target,pin.mode);
    files.push({workspace,file:relative,status:'current'}); continue;
   }
   if(original) {
    const backup=target+'.before-'+hash(original);
    try { await writeFile(backup,original,{flag:'wx',mode:0o600}); }
    catch(e) { if(e.code !== 'EEXIST' || hash(await regular(backup)) !== hash(original)) throw e; }
   }
   const temp=target+'.'+randomUUID()+'.tmp';
   try {
    await writeFile(temp,source,{flag:'wx',mode:pin.mode});
    const current=await regular(target);
    if((current===null)!==(original===null) || current && hash(current)!==hash(original)) throw Error('native_cron_target_changed');
    await rename(temp,target);
   } finally { await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
   files.push({workspace,file:relative,status:original?'upgraded':'installed'});
  }
 }
 return {status:files.some(f=>f.status==='custom_preserved')?'custom_preserved':'ready',files};
}
