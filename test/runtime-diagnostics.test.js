import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createHermesAdapter } from "../src/adapters/hermes/index.js";
import { createOpenClawAdapter } from "../src/adapters/openclaw/index.js";
import { collectRuntimeDiagnostics } from "../src/core/diagnostics.js";

const INSTALLATION_ID = "sw_ins_diagnostic1234";
const NOW = Date.parse("2026-07-28T08:00:00.000Z");

test("canonical OpenClaw fixture keeps the cross-repository fingerprint", async () => {
  const bytes = await readFile(
    new URL("./fixtures/runtime-diagnostics-v1/openclaw.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "d3ce1f3508e94787662e89973e9e591524160d29641af3b44f4a29b2874a980c",
  );
});

test("OpenClaw diagnostic probe is bounded, deterministic and privacy closed", async () => {
  const adapter = createOpenClawAdapter({
    version: "2026.7.1",
    installationId: INSTALLATION_ID,
    diagnosticProbes: {
      runtime: async () => ({
        outcome: "ok",
        facts: [
          { key: "gateway.running", status: "ok", severity: "info", value: true, source: "gateway.status" },
          { key: "unsafe.prompt", status: "ok", severity: "info", value: "private" },
        ],
      }),
      connectivity: async () => ({
        outcome: "degraded",
        facts: [{ key: "provider.reachable", status: "degraded", severity: "warning", value: false }],
      }),
    },
  });
  const first = await adapter.collectDiagnostics({ now: () => NOW });
  const second = await adapter.collectDiagnostics({ now: () => NOW });
  assert.deepEqual(first, second);
  assert.equal(first.schema, "sidewisp.runtime-diagnostics.v1");
  assert.equal(first.collection.outcome, "degraded");
  assert.equal(first.sections[0].facts.length, 1);
  assert.equal(JSON.stringify(first).includes("private"), false);
  assert.deepEqual(first.sections.map(({ key }) => key), [
    "runtime", "configuration", "connectivity", "storage", "scheduler",
    "integrations", "updates",
  ]);
});

test("slow and failed probes become explicit partial collection without raw errors", async () => {
  const snapshot = await collectRuntimeDiagnostics({
    installationId: INSTALLATION_ID,
    runtimeKind: "openclaw",
    runtimeVersion: "2026.7.1",
    adapterName: "sidewisp.openclaw",
    adapterVersion: "0.1.0",
    now: () => NOW,
    timeoutMs: 5,
    probes: {
      runtime: () => new Promise(() => {}),
      storage: async () => { throw new Error("secret path /root/private"); },
    },
  });
  assert.equal(snapshot.collection.outcome, "degraded");
  assert.equal(snapshot.collection.code, "partial_collection");
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.equal(snapshot.sections.find(({ key }) => key === "runtime").outcome, "error");
});

test("generic adapter proves runtime-neutral unsupported snapshots", async () => {
  const snapshot = await createHermesAdapter({ version: "1.2.3" }).collectDiagnostics({
    installationId: INSTALLATION_ID,
    now: () => NOW,
  });
  assert.equal(snapshot.collection.outcome, "unsupported");
  assert.equal(snapshot.runtime.kind, "hermes");
  assert.deepEqual(snapshot.sections, []);
});
