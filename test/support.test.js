import assert from "node:assert/strict";
import test from "node:test";

import { createSafeSupportBundle } from "../src/core/support.js";

test("safe support bundle is stable offline and contains metadata only", () => {
  const bundle = createSafeSupportBundle({
    pluginVersion: "0.1.0", runtimeVersion: "2026.7.1", endpoint: "https://ingest.sidewisp.test/private/path",
    installation: { state: "active", installationId: "sw_ins_hidden" },
    spool: { status: "degraded", bytes: 512, maxBytes: 1024, recoveredFromCorruption: false },
    uploader: { status: "retry", sent: 0, remaining: 3, at: "2026-07-21T00:00:01.000Z" },
    collector: { running: true, startedAt: "2026-07-21T00:00:00.000Z", runtime: "openclaw", adapter: "openclaw-native", capabilities: { "turn-hooks": { status: "supported" } } },
    diagnostic: { code: "backend-unavailable", reason: "timeout", raw: "prompt must not escape" }, generatedAt: "2026-07-21T00:00:02.000Z",
  });
  assert.deepEqual(bundle, {
    schema: "sidewisp.support-bundle.v1", generatedAt: "2026-07-21T00:00:02.000Z",
    plugin: { id: "sidewisp", version: "0.1.0", mode: "zero-llm" },
    runtime: { kind: "openclaw", version: "2026.7.1", adapter: "openclaw-native", compatible: true },
    configuration: { endpointOrigin: "https://ingest.sidewisp.test", installationState: "active" },
    collector: { running: true, startedAt: "2026-07-21T00:00:00.000Z", capabilities: { "turn-hooks": { status: "supported" } } },
    spool: { status: "degraded", bytes: 512, maxBytes: 1024, recoveredFromCorruption: false },
    uploader: { status: "retry", sent: 0, remaining: 3, at: "2026-07-21T00:00:01.000Z" },
    diagnostic: { code: "backend-unavailable", reason: "timeout", localOnly: true },
  });
});

test("support bundle excludes secret corpus, identities, and raw payloads", () => {
  const bundle = createSafeSupportBundle({
    pluginVersion: "0.1.0", runtimeVersion: "2026.7.1", endpoint: "https://user:pass@sidewisp.test/path?token=secret",
    installation: { state: "active", installationId: "sw_ins_secret", secret: "sw_sec_secret" },
    spool: { status: "healthy", events: [{ prompt: "private prompt" }] }, uploader: {}, collector: {},
    diagnostic: { code: "safe-code", reason: "safe-reason", payload: "Bearer abc123" },
  });
  const encoded = JSON.stringify(bundle);
  for (const forbidden of ["user", "pass", "token", "sw_ins_secret", "sw_sec_secret", "private prompt", "Bearer abc123", "events"]) assert.equal(encoded.includes(forbidden), false);
});
