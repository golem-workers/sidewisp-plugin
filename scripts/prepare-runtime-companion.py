#!/usr/bin/env python3
"""Bounded staging-only runtime preparation; existing manager owns plugin install."""
import argparse,hashlib,json,os,pathlib,sqlite3,subprocess,tarfile,tempfile,time,urllib.request
VERSION='2026.9.8-reply-observer.3'
URL='https://github.com/golem-workers/sidewisp-plugin/releases/download/v0.2.63/openclaw-2026.9.8-reply-observer.3.tgz'
SHA='a933b3afeebbf2b7e7ce57f9ec0f94a9478695156f4e5b1a285c3ce23f2d7309'
PLUGIN_SHA='b91437b6e49c49cb69ce8259892cfaf5200ad44236fbd8175abf87b39b9e68d3'
FILES={'dist/dispatch-from-config.finalize-BttBCKPU.mjs':('d63a80eb2261e992f2f869e539e309f89abe7a0d7485f9f39f35f117dee7452f','7278bcc042d7e9ea1ba8d4fb35ccb625b80e75be0e6284fe681f4c4b34b992a9'),'dist/package-update-activation-recovery.mjs':('e08dfc1fb3ba7962f9e01d7a6770117c6cd77406b3fa4f7ba94788a670030ba0','df752055e65824f94abb2f4fc8974a7543f9821540a047c60bd6f84a54608d91')}
H=lambda v:hashlib.sha256(v).hexdigest()
def main():
 a=argparse.ArgumentParser();a.add_argument('--state',required=True);a.add_argument('--runtime',required=True);a.add_argument('--cli',required=True);a.add_argument('--installation',required=True);a.add_argument('--gateway-unit',required=True);a.add_argument('--audit',action='store_true');a.add_argument('--timeout',type=int,default=172800);args=a.parse_args()
 state=pathlib.Path(args.state).resolve();runtime=pathlib.Path(args.runtime).resolve();work=state/'sidewisp/runtime-companion-3963';report=work/'result.json'
 if args.audit:
  r=json.loads(report.read_text()) if report.exists() else {'phase':'not_started'};print(json.dumps(r,sort_keys=True));return
 work.mkdir(mode=0o700,parents=True,exist_ok=True)
 # A journal is terminal for failure and idempotent for success; never implicit retry.
 if report.exists():raise RuntimeError('COMPANION_ALREADY_ATTEMPTED')
 env=os.environ.copy();env.update(OPENCLAW_STATE_DIR=str(state),OPENCLAW_CONFIG_PATH=str(state/'openclaw.json'),OPENCLAW_SYSTEMD_UNIT=args.gateway_unit,NODE_USE_ENV_PROXY='0',NO_PROXY='127.0.0.1,localhost,::1')
 manager='sidewisp-update-manager-'+H(str(state).encode())[:12]+'.service';deadline=time.monotonic()+args.timeout
 r={'phase':'waiting_for_idle','installationId':args.installation,'runtimeCompanion':VERSION,'pluginSha256':PLUGIN_SHA,'done':False,'startedAtMs':int(time.time()*1000)};changed=[];assigned=False
 def save():
  r['observedAtMs']=int(time.time()*1000);tmp=report.with_suffix('.tmp');tmp.write_text(json.dumps(r,sort_keys=True));tmp.chmod(0o600);os.replace(tmp,report)
 def run(cmd):
  x=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=90)
  if x.returncode:raise RuntimeError('COMMAND_FAILED_'+pathlib.Path(cmd[0]).name)
  return x.stdout
 def rpc(method):return json.loads(run([args.cli,'gateway','call',method,'--params','{}','--json']))
 def pid(unit):return int(run(['systemctl','--user','show',unit,'-p','MainPID','--value']).strip())
 def history():
  db=state/'agents/main/agent/openclaw-agent.sqlite'
  if not db.is_file():raise RuntimeError('NATIVE_HISTORY_UNAVAILABLE')
  c=sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)
  try:return set(c.execute('SELECT session_id,event_id FROM transcript_event_identities'))
  finally:c.close()
 def snapshot():
  s=rpc('sidewisp.status');cfg=json.loads((state/'openclaw.json').read_text());cfg.get('plugins',{}).get('installs',{}).pop('sidewisp',None);cred=(state/'sidewisp/installation.json').read_bytes()
  cron=json.loads(run([args.cli,'cron','list','--all','--json']));jobs=cron['jobs'] if isinstance(cron,dict) else cron;keys=['id','name','description','declarationKey','enabled','schedule','sessionTarget','wakeMode','payload','delivery'];jobs=[{k:j.get(k) for k in keys} for j in jobs]
  return {'version':s['version'],'ready':s['connectionReadiness']['ready'],'endpoint':s['endpoint'],'installationId':json.loads(cred)['installationId'],'bindingHash':H(cred),'configHash':H(json.dumps(cfg,sort_keys=True).encode()),'cronHash':H(json.dumps(sorted(jobs,key=lambda j:j['id']),sort_keys=True).encode()),'gatewayPid':pid(args.gateway_unit),'managerPid':pid(manager)}
 def idle():
  lanes=run([args.cli,'gateway','call','diagnostics.lanes','--params','{}','--json']);js="import {isHostIdle} from "+json.dumps((state/'sidewisp/manager/current/src/update/hot-update.js').as_uri())+";console.log(JSON.stringify(isHostIdle(JSON.parse(process.argv[1]))));"
  return json.loads(run(['node','--input-type=module','-e',js,lanes]))
 try:
  save();assert args.timeout>120
  assert json.loads((runtime/'package.json').read_text())['version']=='2026.9.8','UNSUPPORTED_RUNTIME'
  assert json.loads((state/'sidewisp/manager/current/package.json').read_text())['version']=='0.2.62','UNSUPPORTED_MANAGER'
  while time.monotonic()<deadline:
   if idle():break
   time.sleep(5)
  else:raise RuntimeError('HOST_STILL_BUSY')
  before=snapshot();assert before['version']=='0.2.62' and before['ready'] and before['managerPid']>0,'SOURCE_NOT_READY'
  assert before['endpoint']=='https://staging-api.sidewisp.com' and before['installationId']==args.installation,'WRONG_STAGING_BINDING'
  baseline_history=history();(work/'before.json').write_text(json.dumps(before));(work/'before.json').chmod(0o600)
  for name,(original,_) in FILES.items():assert H((runtime/name).read_bytes())==original,'RUNTIME_SOURCE_HASH_MISMATCH'
  data=urllib.request.urlopen(URL,timeout=60).read();assert H(data)==SHA,'OFFICIAL_ARCHIVE_HASH_MISMATCH';archive=work/'official.tgz';archive.write_bytes(data);archive.chmod(0o600)
  with tarfile.open(archive,'r:gz') as tar:
   members={m.name.removeprefix('./'):m for m in tar.getmembers()};prefix='runtime-hotfix/' if 'runtime-hotfix/manifest.json' in members else ''
   # Only known files are read; no archive path is extracted or executed.
   manifest=json.loads(tar.extractfile(members[prefix+'manifest.json']).read());assert manifest['version']==VERSION
   assert {x['path']:(x['beforeSha256'],x['afterSha256']) for x in manifest['files']}==FILES,'MANIFEST_PIN_MISMATCH'
   outputs={name:tar.extractfile(members[prefix+name]).read() for name in FILES}
  # Revalidate true idle, binding and runtime source after network IO.
  assert idle(),'IDLE_LOST_BEFORE_PREPARATION';assert snapshot()==before,'BASELINE_CHANGED'
  for name,(original,target) in FILES.items():
   dest=runtime/name;assert H(dest.read_bytes())==original and H(outputs[name])==target,'OUTPUT_PIN_MISMATCH';backup=work/dest.name;backup.write_bytes(dest.read_bytes());backup.chmod(0o600)
   temp=dest.with_name(dest.name+'.companion3963-next');temp.write_bytes(outputs[name]);os.chmod(temp,dest.stat().st_mode);os.chown(temp,dest.stat().st_uid,dest.stat().st_gid);os.replace(temp,dest);changed.append((dest,backup))
  r.update(phase='prepared_waiting_plugin_policy',prepared=True,idleGatePassed=True,sourceVersion='0.2.62',runtimeHashes={name:H((runtime/name).read_bytes()) for name in FILES});save()
  # Do not call an installer, stop manager/Gateway, or mutate tenant policy.
  while time.monotonic()<deadline:
   try:u=json.loads((state/'sidewisp/update-status.json').read_text())
   except FileNotFoundError:u={}
   if u.get('targetVersion')=='0.2.63' and str(u.get('revision','')).startswith('fleet_status3963_63'):
    assigned=True
    if u.get('status') in ['failed','rolled_back']:raise RuntimeError('SOURCE_UPDATER_TERMINAL_FAILURE')
    if u.get('status')=='completed':break
   time.sleep(5)
  else:raise RuntimeError('PLUGIN_POLICY_PENDING_TIMEOUT')
  assert u.get('installCount')==1,'INSTALL_COUNT_NOT_ONE';after=snapshot();assert after['version']=='0.2.63' and after['ready'],'TARGET_NOT_READY';assert after['gatewayPid']!=before['gatewayPid'],'NO_COLD_ACTIVATION'
  for k in ['endpoint','installationId','bindingHash','configHash','cronHash','managerPid']:assert before[k]==after[k],'PRESERVATION_FAILED_'+k
  assert baseline_history.issubset(history()),'NATIVE_HISTORY_LOST'
  r.update(phase='stability',revision=u['revision'],installCount=1);save();stable=time.monotonic();polls=0
  while time.monotonic()-stable<185:
   current=snapshot();assert current==after,'TARGET_CHANGED_DURING_STABILITY';assert all(H((runtime/name).read_bytes())==v[1] for name,v in FILES.items()),'RUNTIME_TARGET_HASH_CHANGED';polls+=1;time.sleep(15)
  r.update(done=True,phase='completed',servingVersion='0.2.63',bindingPreserved=True,configPreserved=True,cronPreserved=True,historyPreserved=True,historyBaselineEvents=len(baseline_history),managerPidPreserved=True,gatewayPidBefore=before['gatewayPid'],gatewayPidAfter=after['gatewayPid'],stableForMs=int((time.monotonic()-stable)*1000),observations=polls);save()
 except Exception as e:
  reason=str(e);r.update(phase='failed',reason=reason if reason.replace('_','').isalnum() and ' ' not in reason else type(e).__name__,policyObserved=assigned)
  if changed and not assigned:
   # Restore only an unchanged staged output before any plugin policy was observed.
   if pid(args.gateway_unit)==before['gatewayPid'] and all(H(dest.read_bytes())==FILES['dist/'+dest.name][1] for dest,_ in changed):
    for dest,backup in reversed(changed):dest.write_bytes(backup.read_bytes())
    r['runtimeStageRestored']=True
  save();raise
 print(json.dumps(r,sort_keys=True))
if __name__=='__main__':main()
