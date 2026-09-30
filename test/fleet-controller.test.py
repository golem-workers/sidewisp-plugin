import importlib.util, json, tempfile, unittest, io, tarfile, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def module(name):
    s = importlib.util.spec_from_file_location(name, ROOT/'scripts'/f'{name}.py')
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
c = module('fleet-controller'); r = module('fleet-release')
POLICY = {'version':'0.2.34', 'spec':'git:github.com/golem-workers/sidewisp-plugin@v0.2.34', 'sha256':'a'*64, 'allowlist':['sw_ins_test']}

class Fleet(unittest.TestCase):
    def test_transaction_idempotent_and_preserves_unrelated(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'api.env'; p.write_text('SECRET=value with spaces\nSIDEWISP_UPDATE_ROLLOUT_PERCENT=0\n')
            targets=[{'envFile':str(p),'unit':'api','readyUrl':'local'}]; calls=[]
            self.assertEqual(c.apply_policy(targets,POLICY,d,calls.append,lambda _:True),1)
            self.assertIn('SECRET=value with spaces\n',p.read_text())
            self.assertEqual(c.apply_policy(targets,POLICY,d,calls.append,lambda _:True),0)
            self.assertEqual(calls,['api'])
    def test_rolls_back_all_instances_after_late_failure(self):
        with tempfile.TemporaryDirectory() as d:
            files=[Path(d)/f'{i}.env' for i in range(2)]
            for p in files:p.write_text('OTHER=original\n')
            targets=[{'envFile':str(p),'unit':str(i),'readyUrl':str(i)} for i,p in enumerate(files)]
            checks=iter([True,False,True,True]); calls=[]
            with self.assertRaisesRegex(RuntimeError,'APPLY_FAILED_ROLLED_BACK'):
                c.apply_policy(targets,POLICY,d,calls.append,lambda _:next(checks))
            self.assertTrue(all(p.read_text()=='OTHER=original\n' for p in files))
            self.assertEqual(calls,['0','1','1','0'])
    def test_no_restart_when_no_recipients_and_already_disabled(self):
        text='SIDEWISP_PLUGIN_STABLE_VERSION=0.2.17\nSIDEWISP_UPDATE_ROLLOUT_PERCENT=0\n'
        self.assertEqual(c.render_policy(text,{**POLICY,'allowlist':[]}),text)
    def test_inherited_global_rollout_is_overridden_when_no_recipients(self):
        text='PORT=3101\n'
        new=c.render_policy(text,{**POLICY,'allowlist':[]},{'SIDEWISP_UPDATE_ROLLOUT_PERCENT':'100'})
        self.assertIn('SIDEWISP_UPDATE_ROLLOUT_PERCENT=0\n',new)
        self.assertIn('PORT=3101\n',new)
    def test_verify_exact_archive_tag_and_migration_before_acceptance(self):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream,mode='w:gz') as tar:
            data=json.dumps({'name':'@sidewisp/plugin','version':'0.2.34'}).encode()
            info=tarfile.TarInfo('package/package.json');info.size=len(data);tar.addfile(info,io.BytesIO(data))
        data=stream.getvalue();digest=hashlib.sha256(data).hexdigest()
        m={'schema':'sidewisp.verified-fleet.v1','version':'0.2.34','commit':'a'*40,'sha256':digest,
           'environments':['staging'],'verifiedMigrations':['openclaw/0.2.33/2026.9.6'],
           'migrationEvidence':[{'cohort':'openclaw/0.2.33/2026.9.6','targetVersion':'0.2.34',
             'status':'completed','sourceUpdaterTested':True,'isolated':True,'artifactSha256':digest}]}
        meta={'tag_name':'v0.2.34','draft':False,'assets':[{'name':'sidewisp-plugin-0.2.34.tgz',
          'browser_download_url':'https://github.com/golem-workers/sidewisp-plugin/releases/download/v0.2.34/sidewisp-plugin-0.2.34.tgz'}]}
        get=lambda _: {'object':{'type':'commit','sha':'a'*40}}
        self.assertEqual(r.validate(m,meta,lambda _:data,get),m)
        with self.assertRaisesRegex(ValueError,'HASH_MISMATCH'):r.validate(m,meta,lambda _:data+b'x',get)
        with self.assertRaisesRegex(ValueError,'TAG_COMMIT'):r.validate(m,meta,lambda _:data,lambda _: {'object':{'type':'commit','sha':'b'*40}})
        m['deliveryMode']='host-idle-hot-reload-v1'
        for restarts in [None,1,False]:
            m['migrationEvidence'][0]['gatewayRestarts']=restarts
            with self.assertRaisesRegex(ValueError,'ZERO_RESTARTS'):r.validate(m,meta,lambda _:data,get)
        m['migrationEvidence'][0]['gatewayRestarts']=0
        self.assertEqual(r.validate(m,meta,lambda _:data,get),m)
        m['migrationEvidence'][0]['sourceUpdaterTested']=False
        with self.assertRaisesRegex(ValueError,'UNVERIFIED'):r.validate(m,meta,lambda _:data,get)

if __name__ == '__main__':unittest.main()
