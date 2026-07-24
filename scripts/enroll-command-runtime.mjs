#!/usr/bin/env node
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

import { createEnrollmentManager, createFileCredentialStore } from "../src/auth/credentials.js";

const endpoint = new URL(process.env.SIDEWISP_ENDPOINT || "https://api.sidewisp.com");
const stateDir = path.resolve(process.env.SIDEWISP_STATE_DIR || ".");
const setupToken = process.env.SIDEWISP_SETUP_TOKEN || "";

assert.equal(endpoint.protocol, "https:");
await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
await fsp.chmod(stateDir, 0o700);
const auth = createEnrollmentManager({
  endpoint,
  store: createFileCredentialStore({ stateDir }),
});
await auth.load();
if (!auth.canSend()) {
  assert.match(setupToken, /^sw_setup_[A-Za-z0-9_-]{32,}$/);
  await auth.enroll(setupToken);
}
const status = auth.status();
assert.equal(status.state, "active");
process.stdout.write(`${JSON.stringify({
  ok: true,
  installationId: status.installationId,
  endpoint: endpoint.origin,
})}\n`);
