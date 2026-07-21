import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEnrollmentManager, createFileCredentialStore } from "../src/auth/credentials.js";

const credential = { installationId: "sw_ins_fixture001", secret: `sw_sec_${"x".repeat(32)}`, status: "active" };

test("exchanges setup token, persists owner-only credential, and clears token", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let cleared = false;
  let requestBody;
  const store = createFileCredentialStore({ stateDir: root });
  const manager = createEnrollmentManager({ endpoint: "https://sidewisp.test", store, clearSetupToken: async () => { cleared = true; }, fetchImpl: async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return { ok: true, json: async () => credential };
  } });
  assert.deepEqual(await manager.enroll("sw_setup_one_time_secret"), { installationId: credential.installationId, status: "active" });
  assert.deepEqual(requestBody, { setupToken: "sw_setup_one_time_secret" });
  assert.equal(cleared, true);
  assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(store.file))).mode & 0o777, 0o700);
  assert.equal(JSON.stringify(manager.status()).includes("sw_setup"), false);
  assert.equal(JSON.stringify(manager.status()).includes(credential.secret), false);
});

test("rotation is atomic and revoked installations stop sending", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createFileCredentialStore({ stateDir: root });
  await store.write(credential);
  const manager = createEnrollmentManager({ endpoint: "https://sidewisp.test", store });
  await manager.load();
  const rotated = `sw_sec_${"y".repeat(32)}`;
  await manager.rotate(rotated);
  assert.equal((await store.read()).secret, rotated);
  await manager.revoke();
  assert.equal(manager.canSend(), false);
  assert.deepEqual(manager.status(), { state: "revoked", installationId: credential.installationId });
  assert.equal(manager.credential(), null);
});

test("failed exchange keeps token clearing disabled and recovers on retry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  let cleared = false;
  const manager = createEnrollmentManager({ endpoint: "https://sidewisp.test", store: createFileCredentialStore({ stateDir: root }), clearSetupToken: async () => { cleared = true; }, fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => credential };
  } });
  await assert.rejects(manager.enroll("sw_setup_retry_secret"), /503/);
  assert.equal(cleared, false);
  assert.deepEqual(manager.status(), { state: "enrollment-failed", installationId: null });
  await manager.enroll("sw_setup_retry_secret");
  assert.equal(manager.canSend(), true);
});

test("credential remains active when config cleanup fails and cleanup can be retried", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-auth-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let cleanupAttempts = 0;
  const manager = createEnrollmentManager({
    endpoint: "https://sidewisp.test",
    store: createFileCredentialStore({ stateDir: root }),
    clearSetupToken: async () => {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error("config busy");
    },
    fetchImpl: async () => ({ ok: true, json: async () => credential }),
  });
  assert.deepEqual(await manager.enroll("sw_setup_cleanup_retry"), {
    installationId: credential.installationId,
    status: "active",
    setupTokenCleanupPending: true,
  });
  assert.equal(manager.canSend(), true);
  assert.equal(await manager.clearStoredSetupToken(), true);
  assert.equal(cleanupAttempts, 2);
});
