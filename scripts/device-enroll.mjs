#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDeviceAuthorizationClient } from '../src/auth/device-authorization.js';
const [action, id, runtime] = process.argv.slice(2);
try {
  const client = createDeviceAuthorizationClient({ endpoint: process.env.SIDEWISP_ENDPOINT,
    stateDir: process.env.SIDEWISP_STATE_DIR });
  if (!['status','begin','poll','watch-hermes'].includes(action)) throw new Error('expected_status_begin_poll_or_watch_hermes');
  let result;
  if (action === 'watch-hermes') {
    const deadline = Date.now() + 10 * 60_000;
    do {
      result = await client.poll();
      if (result.status !== 'pending') break;
      await delay(5000);
    } while (Date.now() < deadline);
    if (result.status === 'credential_saved') {
      execFileSync('bash', [fileURLToPath(new URL('./install-hermes.sh', import.meta.url))], { env: process.env, stdio: ['ignore','ignore','ignore'] });
      result = { status: 'collector_started', installationId: result.installationId };
    }
  } else result = action === 'status' ? await client.status() : action === 'begin' ? await client.begin({ id, runtime }) : await client.poll();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  // Never serialize provider bodies, local state, fetch errors or credentials.
  const code = /^[a-z_0-9]+$/.test(error.message) ? error.message : 'device_authorization_failed';
  process.stderr.write(`${code}\n`); process.exitCode = 1;
}
