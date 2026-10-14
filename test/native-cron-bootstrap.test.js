import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import { spawnSync } from 'node:child_process';
import { ensureNativeCronHelper, nativeCronWorkspaces } from '../src/bootstrap/native-cron-helper.js';
const endpoint='https://staging-api.sidewisp.com';
const source=await readFile(new URL('../src/bootstrap/native-cron/cron-helper.sh',import.meta.url),'utf8');
async function fixture(t) {const workspace=await mkdtemp(path.join(os.tmpdir(),'sw-native-cron-'));t.after(()=>rm(workspace,{recursive:true,force:true}));return {workspace,options:{endpoint,workspaces:[workspace]}};}
test('fresh connection provisions runnable helper and instructions; reconnect is idempotent',async t=>{
 const f=await fixture(t);assert.equal((await ensureNativeCronHelper(f.options)).status,'ready');
 const helper=path.join(f.workspace,'cron-helper/cron-helper.sh');assert.equal(await readFile(helper,'utf8'),source);assert.ok((await stat(helper)).mode&0o100);
 assert.ok((await readFile(path.join(f.workspace,'skills/native-openclaw-cron/SKILL.md'),'utf8')).includes('cron-helper.sh'));
 assert.ok((await ensureNativeCronHelper(f.options)).files.every(f=>f.status==='current'));
});
test('canonical legacy helper upgrades once with byte-exact backup and without touching jobs/settings',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.workspace,'cron-helper'));
 const legacy=source.replace('    else\n      # Capture the command failure before the if statement resets its status.\n      exit_code=$?\n    fi\n','    fi\n\n    exit_code=$?\n');
 await writeFile(path.join(f.workspace,'cron-helper/cron-helper.sh'),legacy);await writeFile(path.join(f.workspace,'settings.json'),'preserve');
 assert.equal((await ensureNativeCronHelper(f.options)).files[0].status,'upgraded');
 assert.equal(await readFile(path.join(f.workspace,'cron-helper/cron-helper.sh.before-a165a012664adb6c81051311b20417aed9947d4d2556da7d5c58e3525f77c6b3'),'utf8'),legacy);
 assert.equal(await readFile(path.join(f.workspace,'settings.json'),'utf8'),'preserve');
 assert.equal((await ensureNativeCronHelper(f.options)).files[0].status,'current');
});
test('custom helper and custom skill are preserved without claiming a managed helper',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.workspace,'cron-helper'));await writeFile(path.join(f.workspace,'cron-helper/cron-helper.sh'),'custom');
 await mkdir(path.join(f.workspace,'skills/native-openclaw-cron'),{recursive:true});await writeFile(path.join(f.workspace,'skills/native-openclaw-cron/SKILL.md'),'custom instructions');
 assert.equal((await ensureNativeCronHelper(f.options)).status,'custom_preserved');assert.equal(await readFile(path.join(f.workspace,'cron-helper/cron-helper.sh'),'utf8'),'custom');
});
test('production performs no workspace reads/writes',async()=>assert.deepEqual(await ensureNativeCronHelper({endpoint:'https://api.sidewisp.com',workspaces:[]}),{status:'out_of_scope',files:[]}));
test('each explicit agent workspace receives its own helper',async t=>{
 const f=await fixture(t);const second=path.join(f.workspace,'second');await mkdir(second);
 const result=await ensureNativeCronHelper({endpoint,workspaces:[f.workspace,second,f.workspace]});assert.equal(result.files.length,4);
});
test('workspace helper symlinks are refused without changing their target',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.workspace,'untouched'),'data');await mkdir(path.join(f.workspace,'cron-helper'));await symlink(path.join(f.workspace,'untouched'),path.join(f.workspace,'cron-helper/cron-helper.sh'));
 await assert.rejects(ensureNativeCronHelper(f.options),/nonregular/);assert.equal(await readFile(path.join(f.workspace,'untouched'),'utf8'),'data');
});
for(const [kind,expected,attempts] of [['failure',42,1],['pairing',42,3],['recover',0,2],['success',0,1]])test('installed full helper preserves native CLI '+kind,async t=>{
 const f=await fixture(t);await ensureNativeCronHelper(f.options);await mkdir(path.join(f.workspace,'bin'));
 await writeFile(path.join(f.workspace,'bin/openclaw'),`#!/bin/bash\nn=0\n[[ ! -e "$COUNT_FILE" ]] || n=$(cat "$COUNT_FILE")\nn=$((n+1)); printf '%s' "$n" > "$COUNT_FILE"\nif [[ "$TEST_CASE" == success || ( "$TEST_CASE" == recover && "$n" == 2 ) ]]; then printf '{"jobs":[]}\\n'; exit 0; fi\nif [[ "$TEST_CASE" == failure ]]; then echo 'gateway unavailable' >&2; else echo 'pairing required' >&2; fi\nexit 42\n`,{mode:0o755});
 await writeFile(path.join(f.workspace,'openclaw.json'),JSON.stringify({gateway:{port:12345,auth:{token:'fixture-only'}}}));
 const r=spawnSync('bash',[path.join(f.workspace,'cron-helper/cron-helper.sh'),'list','--all','--json'],{encoding:'utf8',env:{...process.env,OPENCLAW_PNPM_HOME:path.join(f.workspace,'absent'),OPENCLAW_STATE_DIR:f.workspace,OPENCLAW_CONFIG_PATH:path.join(f.workspace,'openclaw.json'),OPENCLAW_CRON_RETRY_ATTEMPTS:'3',OPENCLAW_CRON_RETRY_DELAY_SECONDS:'0',PATH:path.join(f.workspace,'bin')+':'+process.env.PATH,TEST_CASE:kind,COUNT_FILE:path.join(f.workspace,'count')}});
 assert.equal(r.status,expected,r.stderr);assert.equal(Number(await readFile(path.join(f.workspace,'count'),'utf8')),attempts);if(expected)assert.doesNotMatch(r.stdout,/ok.*true/);
});

test("shared provisioned base and SDK model workspace are both retained",()=>assert.deepEqual(nativeCronWorkspaces({config:{agents:{defaults:{workspace:"~/workspace"}}},home:"/profile",resolvedWorkspaces:["/profile/workspace/main","/custom/secondary"]}),["/profile/workspace","/profile/workspace/main","/custom/secondary"]));
