import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRuntimeEvent, RUNTIME_MAPPING_VERSION, RUNTIME_MAPPINGS } from "../src/core/normalize.js";

const envelope = {
  eventId: "sw_evt_fixture0000000001", installationId: "sw_ins_fixture001", sequence: 1,
  occurredAt: "2026-07-21T00:00:00.000Z", observedAt: "2026-07-21T00:00:01.000Z",
  runtime: { version: "1.0.0" }, source: { kind: "hook", adapterVersion: "0.1.0" },
};

test("mapping tables are explicitly versioned and cover every shipped runtime", () => {
  assert.equal(RUNTIME_MAPPING_VERSION, "sidewisp.runtime-map.v1");
  assert.ok(Object.keys(RUNTIME_MAPPINGS.openclaw).length >= 10);
  assert.ok(Object.keys(RUNTIME_MAPPINGS.hermes).length >= 10);
  assert.ok(Object.keys(RUNTIME_MAPPINGS.codex).length >= 8);
  assert.ok(Object.keys(RUNTIME_MAPPINGS["claude-code"]).length >= 8);
});

test("OpenClaw and Hermes normalize overlapping facts identically", () => {
  const cases = [
    ["openclaw", { kind: "tool_end", outcome: "failure" }],
    ["hermes", { kind: "tool_call_end", outcome: "failure" }],
  ].map(([runtime, input]) => normalizeRuntimeEvent(runtime, input, envelope).event);
  assert.deepEqual(cases.map(({ type, outcome }) => ({ type, outcome })), [
    { type: "tool.failed", outcome: "failure" }, { type: "tool.failed", outcome: "failure" },
  ]);
});

test("expected cancellation and policy rejection are not failures", () => {
  const cancelled = normalizeRuntimeEvent("openclaw", { kind: "turn_end", outcome: "cancelled" }, envelope).event;
  const rejected = normalizeRuntimeEvent("hermes", { kind: "message_delivery_end", outcome: "policy-rejected" }, envelope).event;
  assert.deepEqual([cancelled.type, cancelled.outcome, cancelled.details.expected], ["turn.cancelled", "info", true]);
  assert.deepEqual([rejected.type, rejected.outcome, rejected.details.expected], ["message.rejected", "info", true]);
});

test("auth, rate limit, timeout, config, queue and context facts normalize deterministically", () => {
  const inputs = [
    ["openclaw", { kind: "provider_error", httpStatus: 401 }, "provider.auth_failed"],
    ["hermes", { kind: "llm_provider_error", httpStatus: 429 }, "provider.rate_limited"],
    ["openclaw", { kind: "turn_end", outcome: "timeout" }, "turn.timeout"],
    ["hermes", { kind: "configuration_error" }, "config.invalid"],
    ["openclaw", { kind: "queue_stuck" }, "queue.stuck"],
    ["hermes", { kind: "context_limit_reached" }, "context.exhausted"],
  ];
  for (const [runtime, input, expected] of inputs) assert.equal(normalizeRuntimeEvent(runtime, input, envelope).event.type, expected);
});

test("unknown or malformed input yields content-free local diagnostic only", () => {
  const result = normalizeRuntimeEvent("openclaw", { kind: "unknown", prompt: "private" }, envelope);
  assert.equal(result.event, null);
  assert.equal(result.diagnostic.localOnly, true);
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("plugin facts never assign incident business state", () => {
  const event = normalizeRuntimeEvent("openclaw", { kind: "runtime_crash" }, envelope).event;
  for (const forbidden of ["incident", "severity", "resolution", "openedAt", "closedAt", "fingerprint"]) {
    assert.equal(Object.hasOwn(event, forbidden), false);
  }
});
