import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { OPENCLAW_HOOK_SOURCES, openClawAgentEventInput, registerOpenClawHooks } from "../src/adapters/openclaw/hooks.js";

const envelope = () => ({
  eventId: `sw_evt_${"x".repeat(20)}`, installationId: "sw_ins_fixture001", sequence: 1,
  occurredAt: "2026-07-21T00:00:00.000Z", observedAt: "2026-07-21T00:00:01.000Z",
  runtime: { version: "2026.7.1" }, source: { kind: "hook", adapterVersion: "0.1.0" },
});

test("registers supported official hooks with bounded host timeouts and no tools/models", async () => {
  const registered = new Map();
  const api = { on: (name, handler, options) => registered.set(name, { handler, options }) };
  const events = [];
  const telemetry = registerOpenClawHooks(api, { emit: async (event) => events.push(event), envelopeFactory: envelope });
  assert.deepEqual([...registered.keys()], Object.keys(OPENCLAW_HOOK_SOURCES));
  assert.ok([...registered.values()].every(({ options }) => options.timeoutMs === 25));
  assert.equal("registerHook" in api, false);
  assert.equal("registerTool" in api, false);
  assert.equal("registerProvider" in api, false);
  registered.get("before_tool_call").handler({ toolName: "exec", params: { password: "private" }, toolCallId: "tool-1" }, { runId: "run-1", sessionId: "session-1" });
  registered.get("after_tool_call").handler({ toolName: "exec", result: "private", error: "private failure", isError: true, exitCode: 13, durationMs: 12, toolCallId: "tool-1" }, { runId: "run-1", sessionId: "session-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["tool.started", "tool.failed"]);
  assert.deepEqual(events[1].details, {
    code: "NONZERO_EXIT", operation: "exec", exitCode: 13, durationMs: 12, recoverable: true,
  });
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.deepEqual(telemetry.status().observed, { before_tool_call: 1, after_tool_call: 1 });
  assert.equal(telemetry.status().emitted, 2);
});

test("equivalent OpenClaw failure matches Hermes normalized failure", async () => {
  const registered = new Map();
  const events = [];
  registerOpenClawHooks({ on: (name, handler) => registered.set(name, handler) }, { emit: async (event) => events.push(event), envelopeFactory: envelope });
  registered.get("agent_end")({ success: false, error: "raw private", runId: "run-1" }, { sessionId: "s" });
  registered.get("message_sent")({ success: false, error: "raw private", messageId: "m" }, { sessionId: "s" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type, outcome }) => ({ type, outcome })), [
    { type: "turn.failed", outcome: "failure" }, { type: "message.failed", outcome: "failure" },
  ]);
  assert.equal(events[0].details.code, "UNKNOWN");
  assert.equal(events[0].details.recoverable, true);
});

test("correlates tool names when completion omits operation and marks signal exits as expected cancellation", async () => {
  const registered = new Map();
  const events = [];
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: async (event) => events.push(event), envelopeFactory: envelope },
  );
  registered.get("before_tool_call")(
    { toolName: "sessions_history", toolCallId: "call-correlated" },
    { runId: "run-1", sessionId: "session-1" },
  );
  registered.get("after_tool_call")(
    { toolCallId: "call-correlated", isError: true, statusCode: 429 },
    { runId: "run-1", sessionId: "session-1" },
  );
  registered.get("after_tool_call")(
    { toolName: "exec", toolCallId: "call-cancelled", isError: true, exitCode: 130 },
    { runId: "run-1", sessionId: "session-1" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[1].type, "tool.failed");
  assert.deepEqual(events[1].details, {
    code: "RATE_LIMITED",
    operation: "sessions_history",
    httpStatus: 429,
    recoverable: true,
  });
  assert.equal(events[2].type, "tool.cancelled");
  assert.equal(events[2].details.expected, true);
  assert.equal(events[2].details.operation, "exec");
});

test("hook and emitter exceptions never escape into OpenClaw", async () => {
  const registered = new Map();
  const diagnostics = [];
  registerOpenClawHooks({ on: (name, handler) => registered.set(name, handler) }, {
    emit: async () => { throw new Error("sink down"); }, envelopeFactory: envelope, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.doesNotThrow(() => registered.get("gateway_start")({ port: 3000 }, {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics[0].localOnly, true);
});

test("rejects the legacy internal-hook API so lifecycle events cannot be silently dropped", () => {
  assert.throws(
    () => registerOpenClawHooks({ registerHook() {} }, { emit: async () => {}, envelopeFactory: envelope }),
    /typed hook API/,
  );
});

test("maps sanitized host agent streams used by Codex and other harnesses", () => {
  assert.deepEqual(
    openClawAgentEventInput({ runId: "run-1", sessionId: "session-1", stream: "lifecycle", data: { phase: "start" } }),
    { kind: "turn_start", correlation: { sessionId: "session-1", turnId: "run-1", toolCallId: undefined } },
  );
  assert.deepEqual(
    openClawAgentEventInput({ runId: "run-1", stream: "tool", data: { phase: "result", name: "exec", toolCallId: "tool-1", status: "failed", isError: true, result: { exitCode: 13, text: "private" } } }),
    {
      kind: "tool_end", outcome: "failure", durationMs: undefined, operation: "exec", status: "failed",
      exitCode: 13, code: "NONZERO_EXIT", recoverable: true,
      correlation: { sessionId: undefined, turnId: "run-1", toolCallId: "tool-1" },
    },
  );
  assert.equal(openClawAgentEventInput({ runId: "run-1", stream: "assistant", data: { text: "private" } }), null);
});

test("official agent event API covers cancellation and user approval without content", () => {
  const cancelled = openClawAgentEventInput({
    runId: "run-cancelled",
    sessionId: "session-1",
    stream: "lifecycle",
    data: { phase: "end", aborted: true, stopReason: "cancelled", error: "private" },
  });
  assert.equal(cancelled.kind, "turn_end");
  assert.equal(cancelled.outcome, "cancelled");

  const waiting = openClawAgentEventInput({
    runId: "run-waiting",
    stream: "approval",
    data: { phase: "requested", status: "pending", kind: "exec", command: "private" },
  });
  const resumed = openClawAgentEventInput({
    runId: "run-waiting",
    stream: "approval",
    data: { phase: "resolved", status: "approved", message: "private" },
  });
  assert.deepEqual(waiting, {
    kind: "tool_start",
    operation: "user_approval",
    correlation: { sessionId: undefined, turnId: "run-waiting", toolCallId: undefined },
  });
  assert.equal(resumed.kind, "tool_end");
  assert.equal(resumed.outcome, "success");
  assert.equal(JSON.stringify([cancelled, waiting, resumed]).includes("private"), false);
});

test("plugin subscribes through the official host-owned agent event API", () => {
  const source = readFileSync(new URL("../src/adapters/openclaw/plugin.js", import.meta.url), "utf8");
  assert.match(source, /api\.agent\.events\.registerAgentEventSubscription/);
  assert.match(source, /streams:\s*\["lifecycle", "tool", "approval"\]/);
  assert.doesNotMatch(source, /onAgentEvent\s*\(/);
});

test("classifies structured failures without copying private error content", () => {
  const mapped = openClawAgentEventInput({
    runId: "run-1", stream: "tool",
    data: { phase: "result", name: "web_fetch", isError: true, statusCode: 429, toolErrorSummary: "Bearer private", args: { token: "private" } },
  });
  assert.equal(mapped.operation, "web_fetch");
  assert.equal(mapped.code, "RATE_LIMITED");
  assert.equal(mapped.recoverable, true);
  assert.equal(mapped.httpStatus, 429);
  assert.equal(JSON.stringify(mapped).includes("private"), false);
});
