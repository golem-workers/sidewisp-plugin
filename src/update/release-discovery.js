import { validUpdateDirective, isNewerVersion } from './directive.js';
const REPO = 'https://api.github.com/repos/golem-workers/sidewisp-plugin';
// New capability code arrives only in immutable, explicitly verified releases.
// No LLM runs, arbitrary URLs, server policy edits, or Gateway restarts.
export function createReleaseDiscovery({currentVersion,runtimeVersion,environment,schedule,fetchImpl=fetch,intervalMs=900000}) {
 let timer=null,running=null,stopped=true;
 async function json(url) {
  const r=await fetchImpl(url,{signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json'}});
  if(!r.ok)throw new Error('release_discovery_unavailable');
  return r.json();
 }
 async function check() {
  const releases=await json(`${REPO}/releases?per_page=20`);
  if(!Array.isArray(releases))return false;
  const cohort=`openclaw/${currentVersion}/${runtimeVersion}`;
  const candidates = releases.filter(r=>r && /^v\d+\.\d+\.\d+$/.test(r.tag_name??''));
  candidates.sort((a,b)=>isNewerVersion(a.tag_name.slice(1),b.tag_name.slice(1))?-1:isNewerVersion(b.tag_name.slice(1),a.tag_name.slice(1))?1:0);
  for(const r of candidates) {
   if(r.draft || !/^v\d+\.\d+\.\d+$/.test(r.tag_name??'') || !isNewerVersion(r.tag_name.slice(1),currentVersion))continue;
   const asset=r.assets?.find(a=>a.name==='fleet-rollout.json');
   const base=`https://github.com/golem-workers/sidewisp-plugin/releases/download/${r.tag_name}/`;
   if(asset?.browser_download_url!==base+'fleet-rollout.json')continue;
   let m;
   try {m=await json(asset.browser_download_url);} catch {continue;}
   if(!m || typeof m!=='object' || !Array.isArray(m.environments) || !Array.isArray(m.verifiedMigrations) || !Array.isArray(m.migrationEvidence))continue;
   if(!['staging','production'].includes(environment) || !m.environments?.includes(environment) || m.schema!=='sidewisp.verified-fleet.v1' || m.version!==r.tag_name.slice(1)
     || !/^[a-f0-9]{40}$/.test(m.commit??'') || !/^[a-f0-9]{64}$/.test(m.sha256??'')
     || !m.verifiedMigrations?.includes(cohort) || m.deliveryMode!=='host-idle-hot-reload-v1')continue;
   const proof=m.migrationEvidence?.find(p=>p && p.cohort===cohort && p.targetVersion===m.version && p.artifactSha256===m.sha256
     && p.status==='completed' && p.sourceUpdaterTested===true && p.isolated===true && p.gatewayRestarts===0);
   if(!proof)continue;
   const directive={schema:'sidewisp.plugin-update.v1',targetVersion:m.version,
    targetSpec:`git:github.com/golem-workers/sidewisp-plugin@v${m.version}`,sha256:m.sha256,restartDelaySeconds:60};
   if(validUpdateDirective(directive))return schedule(directive);
  }
  return false;
 }
 const tick=()=>running??(running=check().finally(()=>{running=null;}));
 const queue=()=>{if(stopped)return;timer=setTimeout(()=>void tick().catch(()=>{}).finally(queue),intervalMs);timer.unref?.();};
 return {start(){if(!stopped)return;stopped=false;queue();},async stop(){stopped=true;clearTimeout(timer);await running?.catch(()=>{});},check:tick};
}
