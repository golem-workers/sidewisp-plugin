import assert from "node:assert/strict";
import test from "node:test";

import { localSanitizationDiagnostic, sanitizeTelemetryEvent, SanitizationError } from "../src/core/sanitize.js";

function event() {
  return {
    eventId: "sw_evt_openclaw0000000001", installationId: "sw_ins_fixture001", sequence: 1,
    occurredAt: "2026-07-21T00:00:00.000Z", observedAt: "2026-07-21T00:00:01.000Z",
    runtime: { kind: "openclaw", version: "2026.7.1" }, source: { kind: "hook", adapterVersion: "0.1.0" },
    type: "tool.failed", outcome: "failure", correlation: { sessionId: "session-1" },
    details: { code: "tool-error", recoverable: true },
  };
}

test("constructs a closed payload and excludes raw sensitive classes recursively", () => {
  const input = event();
  input.prompt = "private prompt";
  input.response = "private response";
  input.tool = { arguments: { password: "hunter2" }, result: "private" };
  input.files = [{ path: "/private/file" }];
  input.personal = { email: "person@example.test" };
  input.runtime.vendor = { authorization: "Bearer secret" };
  const output = sanitizeTelemetryEvent(input);
  const serialized = JSON.stringify(output);
  for (const secret of ["private prompt", "private response", "hunter2", "/private/file", "person@example.test", "Bearer secret"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(Object.keys(output.details), ["code", "recoverable"]);
  assert.deepEqual(Object.keys(output.runtime), ["kind", "version"]);
});

test("rejects a secret corpus in allowlisted fields", () => {
  for (const secret of ["Bearer abc123", "api_key-secret", "https://user:pass@example.test", "password-value", "credential-data"]) {
    const input = event();
    input.details.reason = secret;
    assert.throws(() => sanitizeTelemetryEvent(input), SanitizationError);
  }
});

test("enforces field bounds and safe scalar encoding", () => {
  const oversized = event();
  oversized.details.code = "x".repeat(257);
  assert.throws(() => sanitizeTelemetryEvent(oversized), /unsafe-code/);
  const nested = event();
  nested.details.count = { value: 1 };
  assert.throws(() => sanitizeTelemetryEvent(nested), /invalid-count/);
  const missingRuntimeKind = event();
  delete missingRuntimeKind.runtime.kind;
  assert.throws(() => sanitizeTelemetryEvent(missingRuntimeKind), /invalid-runtime-kind/);
});

test("fails closed with a content-free local diagnostic", () => {
  const input = event();
  Object.defineProperty(input.details, "reason", { enumerable: true, get() { throw new Error("secret getter text"); } });
  let caught;
  try { sanitizeTelemetryEvent(input); } catch (error) { caught = error; }
  const diagnostic = localSanitizationDiagnostic(caught);
  assert.deepEqual(diagnostic, {
    type: "collector.degraded", code: "telemetry-sanitization-failed", reason: "unreadable-input", localOnly: true,
  });
  assert.equal(JSON.stringify(diagnostic).includes("secret getter text"), false);
});
