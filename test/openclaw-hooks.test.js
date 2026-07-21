import assert from "node:assert/strict";
import test from "node:test";
import { OPENCLAW_HOOK_SOURCES, registerOpenClawHooks } from "../src/adapters/openclaw/hooks.js";

const envelope = () => ({
  eventId: `sw_evt_${"x".repeat(20)}`, installationId: "sw_ins_fixture001", sequence: 1,
  occurredAt: "2026-07-21T00:00:00.000Z", observedAt: "2026-07-21T00:00:01.000Z",
  runtime: { version: "2026.7.1" }, source: { kind: "hook", adapterVersion: "0.1.0" },
});

test("registers supported official hooks with bounded host timeouts and no tools/models", async () => {
  const registered = new Map();
  const api = { registerHook: (name, handler, options) => registered.set(name, { handler, options }) };
  const events = [];
  registerOpenClawHooks(api, { emit: async (event) => events.push(event), envelopeFactory: envelope });
  assert.deepEqual([...registered.keys()], Object.keys(OPENCLAW_HOOK_SOURCES));
  assert.ok([...registered.values()].every(({ options }) => options.timeoutMs === 25));
  assert.ok([...registered.entries()].every(([name, { options }]) => options.name === `sidewisp-${name}`));
  assert.equal("registerTool" in api, false);
  assert.equal("registerProvider" in api, false);
  registered.get("before_tool_call").handler({ toolName: "exec", params: { password: "private" }, toolCallId: "tool-1" }, { runId: "run-1", sessionId: "session-1" });
  registered.get("after_tool_call").handler({ toolName: "exec", result: "private", error: "private failure", durationMs: 12, toolCallId: "tool-1" }, { runId: "run-1", sessionId: "session-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["tool.started", "tool.failed"]);
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("equivalent OpenClaw failure matches Hermes normalized failure", async () => {
  const registered = new Map();
  const events = [];
  registerOpenClawHooks({ registerHook: (name, handler) => registered.set(name, handler) }, { emit: async (event) => events.push(event), envelopeFactory: envelope });
  registered.get("agent_end")({ success: false, error: "raw private", runId: "run-1" }, { sessionId: "s" });
  registered.get("message_sent")({ success: false, error: "raw private", messageId: "m" }, { sessionId: "s" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type, outcome }) => ({ type, outcome })), [
    { type: "turn.failed", outcome: "failure" }, { type: "message.failed", outcome: "failure" },
  ]);
});

test("hook and emitter exceptions never escape into OpenClaw", async () => {
  const registered = new Map();
  const diagnostics = [];
  registerOpenClawHooks({ registerHook: (name, handler) => registered.set(name, handler) }, {
    emit: async () => { throw new Error("sink down"); }, envelopeFactory: envelope, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.doesNotThrow(() => registered.get("gateway_start")({ port: 3000 }, {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics[0].localOnly, true);
});
