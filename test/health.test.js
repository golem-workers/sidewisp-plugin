import assert from "node:assert/strict";
import test from "node:test";

import { createHermesAdapter } from "../src/adapters/hermes/index.js";
import { createOpenClawAdapter } from "../src/adapters/openclaw/index.js";
import { HEALTH_CHECKS, runBoundedProbe } from "../src/core/health.js";

const healthyProbes = () => Object.fromEntries(HEALTH_CHECKS.map((name) => [name, async ({ signal }) => {
  assert.equal(signal.aborted, false);
  return { status: "healthy" };
}]));

test("OpenClaw and Hermes produce the same health snapshot shape", async () => {
  const snapshots = await Promise.all([
    createOpenClawAdapter({ version: "2026.7.1", probes: healthyProbes() }).healthSnapshot(),
    createHermesAdapter({ version: "0.9.0", probes: healthyProbes() }).healthSnapshot(),
  ]);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.schema, "sidewisp.health.v1");
    assert.equal(snapshot.overall, "healthy");
    assert.deepEqual(snapshot.checks.map(({ name }) => name), HEALTH_CHECKS);
    assert.deepEqual(Object.keys(snapshot).sort(), ["adapter", "capabilities", "checks", "observedAt", "overall", "runtime", "schema"]);
  }
});

test("probe timeout is strict and aborts work", async () => {
  let signal;
  const result = await runBoundedProbe("process", ({ signal: current }) => {
    signal = current;
    return new Promise(() => {});
  }, { timeoutMs: 10 });
  assert.equal(result.status, "degraded");
  assert.equal(result.reason, "probe-timeout");
  assert.equal(signal.aborted, true);
});

test("probe API exposes only an AbortSignal and returns bounded fields", async () => {
  const result = await runBoundedProbe("config", (context) => {
    assert.deepEqual(Object.keys(context), ["signal"]);
    return { status: "healthy", privatePayload: "must-not-pass" };
  });
  assert.deepEqual(Object.keys(result).sort(), ["durationMs", "name", "status"]);
});

test("failures and missing probes degrade explicitly without throwing", async () => {
  assert.equal((await runBoundedProbe("gateway", async () => { throw new Error("private"); })).reason, "probe-failed");
  assert.equal((await runBoundedProbe("spool")).status, "unsupported");
  await assert.rejects(() => runBoundedProbe("process", async () => ({}), { timeoutMs: 50_000 }), /between 10 and 5000/);
});
