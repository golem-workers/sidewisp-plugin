import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeDiagnosticsDelivery } from "../src/delivery/runtime-diagnostics.js";

const credential = {
  status: "active",
  installationId: "sw_ins_test123456",
  secret: "test-secret",
};
function snapshot(id, observedAt = "2026-07-28T00:00:00.000Z") {
  return {
    schema: "sidewisp.runtime-diagnostics.v1",
    snapshotId: id,
    installationId: credential.installationId,
    observedAt,
    ttlSeconds: 900,
    runtime: { kind: "openclaw", version: "2026.7.1" },
    adapter: { name: "openclaw", version: "0.2.9" },
    collection: { outcome: "ok" },
    sections: [],
    truncation: { truncated: false, omittedSections: 0, omittedFacts: 0 },
  };
}
function memorySpool() {
  let pending = null;
  return {
    coalesceRuntimeDiagnostic(value) { pending = value; },
    pendingRuntimeDiagnostic() {
      return pending ? { snapshotId: pending.snapshotId, snapshot: pending } : null;
    },
    acknowledgeRuntimeDiagnostic(_installationId, id) {
      if (pending?.snapshotId !== id) return false;
      pending = null;
      return true;
    },
    get pending() { return pending; },
  };
}

test("delivery signs, acknowledges and removes only the matching snapshot", async () => {
  const spool = memorySpool();
  let request;
  const delivery = createRuntimeDiagnosticsDelivery({
    adapter: { collectDiagnostics: async () => snapshot("sw_diag_one") },
    spool,
    endpoint: "https://sidewisp.test",
    credentialProvider: { current: async () => credential },
    now: () => Date.parse("2026-07-28T00:00:00.000Z"),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return { ok: true, status: 200, json: async () => ({
        schema: "sidewisp.runtime-diagnostics-ack.v1",
        snapshotId: "sw_diag_one",
        accepted: true,
        current: true,
      }) };
    },
  });
  assert.equal((await delivery.run()).status, "sent");
  assert.equal(spool.pending, null);
  assert.match(request.url, /\/v1\/runtime-diagnostics\/snapshots$/);
  assert.match(request.init.headers.authorization, /^Sidewisp sw_ins_test123456:/);
});

test("outage coalesces newest snapshot and recovers without overlap", async () => {
  const spool = memorySpool();
  let id = 0;
  let active = 0;
  let maxActive = 0;
  let online = false;
  const delivery = createRuntimeDiagnosticsDelivery({
    adapter: { async collectDiagnostics() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      id += 1;
      const value = snapshot(`sw_diag_${id}`);
      value.runtime.version = `2026.7.${id}`;
      return value;
    } },
    spool,
    endpoint: "https://sidewisp.test",
    credentialProvider: { current: async () => credential },
    fetchImpl: async () => {
      if (!online) throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ snapshotId: spool.pending.snapshotId }) };
    },
  });
  const first = delivery.run();
  const same = delivery.run();
  assert.equal(first, same);
  assert.equal((await first).status, "retry");
  assert.equal(spool.pending.snapshotId, "sw_diag_1");
  await delivery.run();
  assert.equal(spool.pending.snapshotId, "sw_diag_2");
  online = true;
  assert.equal((await delivery.upload()).status, "sent");
  assert.equal(spool.pending, null);
  assert.equal(maxActive, 1);
});

test("startup uses bounded jitter and retries use exponential backoff", () => {
  const scheduled = [];
  const delivery = createRuntimeDiagnosticsDelivery({
    adapter: { collectDiagnostics: async () => snapshot("sw_diag_one") },
    spool: memorySpool(),
    endpoint: "https://sidewisp.test",
    credentialProvider: { current: async () => credential },
    random: () => 0.5,
    intervalMs: 1000,
    setTimer: (_fn, delay) => { scheduled.push(delay); return { unref() {} }; },
    clearTimer() {},
  });
  delivery.start();
  assert.deepEqual(scheduled, [500]);
  assert.equal(delivery.retryDelayMs(), 750);
});

test("backend rejection and clock-skew response retain the newest snapshot", async () => {
  for (const status of [400, 422]) {
    const spool = memorySpool();
    const delivery = createRuntimeDiagnosticsDelivery({
      adapter: { collectDiagnostics: async () => snapshot("sw_diag_clock") },
      spool,
      endpoint: "https://sidewisp.test",
      credentialProvider: { current: async () => credential },
      fetchImpl: async () => ({ ok: false, status }),
    });
    assert.equal((await delivery.run()).status, "rejected");
    assert.equal(spool.pending.snapshotId, "sw_diag_clock");
  }
});
