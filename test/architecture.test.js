import assert from "node:assert/strict";
import test from "node:test";

import { createHermesAdapter } from "../src/adapters/hermes/index.js";
import { createOpenClawAdapter } from "../src/adapters/openclaw/index.js";
import { createCollector } from "../src/core/collector.js";
import { ADAPTER_CONTRACT, createAdapterRegistry, declareCapabilities, defineRuntimeAdapter } from "../src/core/runtime-adapter.js";

function fixtureAdapter() {
  let running = false;
  return defineRuntimeAdapter({
    contract: ADAPTER_CONTRACT,
    id: "fixture",
    runtimeKind: "fixture",
    version: "1.0.0",
    capabilities: declareCapabilities([]),
    async start() { running = true; },
    async stop() { running = false; },
    async recover(cursor) { return cursor; },
    async healthSnapshot() { return { status: running ? "healthy" : "stopped" }; },
  });
}

test("registry selects OpenClaw, Hermes, and a fixture adapter explicitly", () => {
  const registry = createAdapterRegistry([
    createOpenClawAdapter({}), createHermesAdapter(), fixtureAdapter(),
  ]);
  assert.deepEqual(registry.list().map(({ runtimeKind }) => runtimeKind), ["openclaw", "hermes", "fixture"]);
  assert.equal(registry.select("fixture").id, "fixture");
  assert.throws(() => registry.select("unknown"), /unsupported runtime/);
});

test("all adapters expose the complete capability declaration", () => {
  for (const adapter of [createOpenClawAdapter({}), createHermesAdapter(), fixtureAdapter()]) {
    assert.equal(Object.keys(adapter.capabilities).length, 8);
    assert.ok(Object.values(adapter.capabilities).every(({ status }) => status));
  }
});

test("shared collector owns lifecycle and recovery for any adapter", async () => {
  const collector = createCollector({ adapter: fixtureAdapter() });
  await collector.start();
  assert.equal((await collector.status()).health.status, "healthy");
  assert.deepEqual(await collector.recover({ source: "log", value: "10" }), { source: "log", value: "10" });
  await collector.stop();
  assert.equal((await collector.status()).health.status, "stopped");
});

test("duplicate runtimes and implicit capabilities are rejected", () => {
  const fixture = fixtureAdapter();
  assert.throws(() => createAdapterRegistry([fixture, fixture]), /duplicate runtime/);
  assert.throws(() => defineRuntimeAdapter({ ...fixture, capabilities: {} }), /must be explicit/);
});
