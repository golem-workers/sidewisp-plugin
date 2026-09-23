import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('Hermes reinstall restarts an existing collector to reload newly approved credentials', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'sw-hermes-reinstall-'));
 try {
  const bin=path.join(root,'bin'),state=path.join(root,'state');await fs.mkdir(bin);await fs.mkdir(path.join(state,'sidewisp'),{recursive:true});
  await fs.writeFile(path.join(state,'sidewisp/installation.json'),JSON.stringify({installationId:'sw_ins_fixture000',secret:'sw_secret_'+'a'.repeat(43),status:'active'}));
  const log=path.join(root,'calls');
  await fs.writeFile(path.join(bin,'systemctl'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_CALLS"\nexit 0\n',{mode:0o700});
  execFileSync('bash',[new URL('../scripts/install-hermes.sh',import.meta.url).pathname],{env:{...process.env,PATH:bin+':'+process.env.PATH,SIDEWISP_STATE_DIR:state,SIDEWISP_INSTALL_ROOT:path.join(root,'install'),XDG_CONFIG_HOME:path.join(root,'config'),HERMES_SOURCE_DIR:root,SIDEWISP_ENDPOINT:'https://example.com',TEST_CALLS:log},stdio:'pipe'});
  const calls=(await fs.readFile(log,'utf8')).trim().split('\n');
  assert.ok(calls.includes('--user restart sidewisp-hermes.service'));
  assert.ok(calls.indexOf('--user daemon-reload')<calls.indexOf('--user restart sidewisp-hermes.service'));
  assert.ok(calls.indexOf('--user restart sidewisp-hermes.service')<calls.indexOf('--user is-active --quiet sidewisp-hermes.service'));
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
