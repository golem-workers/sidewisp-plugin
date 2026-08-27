import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createOpenClawUserTaskLifecycle,
  OPENCLAW_HOOK_SOURCES,
  openClawAgentEventInput,
  registerOpenClawHooks,
} from "../src/adapters/openclaw/hooks.js";
import { stableOpenClawEventId } from "../src/adapters/openclaw/recovery.js";

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
  registered.get("message_received").handler(
    { messageId: "message-1", text: "private inbound" },
    { sessionId: "session-1" },
  );
  registered.get("message_sent").handler(
    { messageId: "message-1", text: "private outbound", success: true },
    { sessionId: "session-1" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["message.received", "turn.completed"]);
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.deepEqual(telemetry.status().observed, { message_received: 1, message_sent: 1 });
  assert.equal(telemetry.status().emitted, 2);
});

test("an unsuccessful outgoing message closes the task as a sanitized failure", async () => {
  const registered = new Map();
  const events = [];
  registerOpenClawHooks({ on: (name, handler) => registered.set(name, handler) }, { emit: async (event) => events.push(event), envelopeFactory: envelope });
  registered.get("message_sent")({ success: false, error: "raw private", messageId: "m" }, { sessionId: "s" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type, outcome }) => ({ type, outcome })), [
    { type: "turn.failed", outcome: "failure" },
  ]);
  assert.equal(JSON.stringify(events).includes("private"), false);
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

test("typed hook counters distinguish accepted and coalesced events", async () => {
  const registered = new Map();
  const telemetry = registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: async () => false, envelopeFactory: envelope },
  );
  registered.get("gateway_start")({}, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(telemetry.status().emitted, 0);
  assert.equal(telemetry.status().ignored, 1);
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

test("official approval identity distinguishes approvals and deduplicates repeats", () => {
  const first = openClawAgentEventInput({
    runId: "run-waiting",
    stream: "approval",
    data: {
      phase: "requested",
      status: "pending",
      approvalId: "approval-one",
      prompt: "private one",
    },
  });
  const second = openClawAgentEventInput({
    runId: "run-waiting",
    stream: "approval",
    data: {
      phase: "requested",
      status: "pending",
      approvalSlug: "approval-two",
      prompt: "private two",
    },
  });
  const repeated = openClawAgentEventInput({
    runId: "run-waiting",
    stream: "approval",
    data: {
      phase: "requested",
      status: "pending",
      approvalId: "approval-one",
      prompt: "different private content",
    },
  });
  assert.equal(first.correlation.toolCallId, "approval-one");
  assert.equal(second.correlation.toolCallId, "approval-two");
  assert.notEqual(stableOpenClawEventId(first), stableOpenClawEventId(second));
  assert.equal(stableOpenClawEventId(first), stableOpenClawEventId(repeated));
  assert.equal(JSON.stringify([first, second, repeated]).includes("private"), false);
});

test("coalesces internal runs into one lifecycle for one incoming message", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const event = (type, { sessionId = "session-one", messageId, turnId } = {}) => ({
    type,
    correlation: { sessionId, messageId, turnId },
  });
  assert.equal(lifecycle.process(event("message.received", { messageId: "message-one" })).type, "turn.started");
  assert.equal(lifecycle.process(event("turn.started", { turnId: "internal-run-one" })), null);
  assert.ok(lifecycle.process(event("tool.started", { turnId: "internal-run-one" })));
  assert.ok(lifecycle.process(event("tool.completed", { turnId: "internal-run-one" })));
  assert.equal(lifecycle.process(event("turn.completed", { turnId: "internal-run-one" })), null);
  assert.equal(lifecycle.process(event("turn.started", { turnId: "internal-run-two" })), null);
  assert.equal(lifecycle.process(event("turn.completed", { turnId: "internal-run-two" })), null);
  assert.ok(lifecycle.process(event("turn.completed", { messageId: "outgoing-one" })));
  assert.equal(lifecycle.process(event("turn.completed", { messageId: "outgoing-two" })), null);
});

test("preserves waiting, failures, autonomous runs, and concurrent sessions", () => {
  const deferred = new Set();
  const released = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    cancel: (handle) => deferred.delete(handle),
    onDeferred: (event) => released.push(event),
    onSuppressed: (event) => suppressed.push(event),
    schedule: (callback) => { deferred.add(callback); return callback; },
  });
  const flushDeferred = () => {
    for (const callback of [...deferred]) {
      deferred.delete(callback);
      callback();
    }
  };
  const event = (type, correlation) => ({ type, correlation });
  assert.ok(lifecycle.process(event("message.received", { sessionId: "waiting", messageId: "m-wait" })));
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "waiting", turnId: "r-wait" })), null);
  assert.ok(lifecycle.process(event("tool.started", { sessionId: "waiting", turnId: "r-wait", toolCallId: "approval" })));
  assert.ok(lifecycle.process(event("tool.completed", { sessionId: "waiting", turnId: "r-wait", toolCallId: "approval" })));
  assert.equal(lifecycle.process(event("turn.failed", { sessionId: "waiting", turnId: "r-wait" })), null);
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "waiting", turnId: "r-retry" })), null);
  assert.equal(lifecycle.process(event("turn.completed", { sessionId: "waiting", turnId: "r-retry" })), null);
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "waiting", messageId: "out-wait" })));
  assert.deepEqual(released, []);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);

  for (const [sessionId, messageId, terminal] of [
    ["timeout", "m-timeout", "turn.timeout"],
    ["cancel", "m-cancel", "turn.cancelled"],
  ]) {
    assert.ok(lifecycle.process(event("message.received", { sessionId, messageId })));
    assert.equal(lifecycle.process(event("turn.started", { sessionId, turnId: `run-${sessionId}` })), null);
    assert.equal(lifecycle.process(event(terminal, { sessionId, turnId: `run-${sessionId}` })), null);
    flushDeferred();
    assert.equal(released.at(-1).type, terminal);
  }

  assert.ok(lifecycle.process(event("message.received", { sessionId: "a", messageId: "m-a" })));
  assert.ok(lifecycle.process(event("message.received", { sessionId: "b", messageId: "m-b" })));
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "a", turnId: "run-a" })), null);
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "b", turnId: "run-b" })), null);
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "b", messageId: "m-b" })));
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "a", messageId: "m-a" })));

  assert.ok(lifecycle.process(event("turn.started", { turnId: "autonomous" })));
  assert.equal(lifecycle.process(event("turn.started", { turnId: "autonomous" })), null);
  assert.ok(lifecycle.process(event("turn.completed", { turnId: "autonomous" })));
  assert.equal(lifecycle.process(event("turn.failed", { turnId: "autonomous" })), null);

  assert.ok(lifecycle.process(event("message.received", { sessionId: "same", messageId: "same-message" })));
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "same", turnId: "user-run" })), null);
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "same", messageId: "user-out" })));
  assert.ok(lifecycle.process(event("turn.started", { sessionId: "same", turnId: "autonomous-same-session" })));
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "same", turnId: "autonomous-same-session" })));
});

test("queues multiple incoming messages within one session without cross-linking tasks", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const event = (type, correlation) => ({ type, correlation });
  assert.ok(lifecycle.process(event("message.received", { sessionId: "shared", messageId: "m-one" })));
  assert.ok(lifecycle.process(event("message.received", { sessionId: "shared", messageId: "m-two" })));
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "shared", turnId: "run-one" })), null);
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "shared", turnId: "internal-one" })), null);
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "shared", messageId: "out-one" })));
  assert.equal(lifecycle.process(event("turn.completed", { sessionId: "shared", messageId: "extra-out" })), null);
  assert.ok(lifecycle.process(event("turn.started", { sessionId: "shared", turnId: "run-two" })));
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "shared", messageId: "out-two" })));
  assert.equal(lifecycle.process(event("turn.completed", { sessionId: "shared", messageId: "duplicate-out" })), null);
});

test("does not mistake a queued message for a retry during terminal grace", async () => {
  const deferred = new Set();
  const released = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    cancel: (handle) => deferred.delete(handle),
    onDeferred: async (event) => released.push(event),
    schedule: (callback) => { deferred.add(callback); return callback; },
  });
  const event = (type, correlation) => ({ type, correlation });
  assert.ok(lifecycle.process(event("message.received", { sessionId: "shared", messageId: "m-one" })));
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "shared", turnId: "run-one" })), null);
  assert.equal(lifecycle.process(event("turn.failed", { sessionId: "shared", turnId: "run-one" })), null);
  assert.ok(lifecycle.process(event("message.received", { sessionId: "shared", messageId: "m-two" })));
  assert.ok(lifecycle.process(event("turn.started", { sessionId: "shared", turnId: "run-two" })));
  await Promise.resolve();
  assert.deepEqual(released.map(({ type }) => type), ["turn.failed"]);
  assert.ok(lifecycle.process(event("turn.completed", { sessionId: "shared", messageId: "out-two" })));
});

test("flushes deferred terminal events before shutdown", async () => {
  const released = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: async (event) => released.push(event),
    schedule: () => ({ unref() {} }),
  });
  const event = (type, correlation) => ({ type, correlation });
  lifecycle.process(event("message.received", { sessionId: "shutdown", messageId: "message" }));
  lifecycle.process(event("turn.started", { sessionId: "shutdown", turnId: "run" }));
  lifecycle.process(event("turn.cancelled", { sessionId: "shutdown", turnId: "run" }));
  assert.equal(lifecycle.status().pendingTerminals, 1);
  await lifecycle.flushPending();
  assert.deepEqual(released.map(({ type }) => type), ["turn.cancelled"]);
  assert.equal(lifecycle.status().pendingTerminals, 0);
});

test("bounds and expires run-only lifecycle state without reading content", () => {
  let nowMs = 1_000;
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: () => nowMs,
    maxRuns: 2,
    ttlMs: 50,
  });
  const event = (turnId) => ({
    type: "turn.started",
    correlation: { turnId },
    get details() { throw new Error("private content read"); },
  });
  assert.ok(lifecycle.process(event("run-one")));
  assert.ok(lifecycle.process(event("run-two")));
  assert.ok(lifecycle.process(event("run-three")));
  assert.equal(lifecycle.status().trackedRuns, 2);
  assert.ok(lifecycle.process(event("run-one")));
  assert.equal(lifecycle.status().trackedRuns, 2);
  nowMs += 51;
  assert.ok(lifecycle.process(event("run-one")));
  assert.equal(lifecycle.status().trackedRuns, 1);
});

test("refreshes task TTL from bounded lifecycle activity", () => {
  let nowMs = 1_000;
  const lifecycle = createOpenClawUserTaskLifecycle({ now: () => nowMs, ttlMs: 50 });
  const event = (type, correlation) => ({ type, correlation });
  assert.ok(lifecycle.process(event("message.received", { sessionId: "long", messageId: "message" })));
  nowMs += 40;
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "long", turnId: "run" })), null);
  nowMs += 40;
  assert.ok(lifecycle.process(event("tool.started", { sessionId: "long", turnId: "run", toolCallId: "tool" })));
  nowMs += 40;
  assert.equal(lifecycle.process(event("turn.started", { sessionId: "long", turnId: "internal" })), null);
  assert.equal(lifecycle.status().trackedRuns, 1);
});

test("plugin subscribes through the official host-owned agent event API", () => {
  const source = readFileSync(new URL("../src/adapters/openclaw/plugin.js", import.meta.url), "utf8");
  assert.match(source, /api\.agent\.events\.registerAgentEventSubscription/);
  assert.match(source, /streams:\s*\["lifecycle", "tool", "approval"\]/);
  assert.match(source, /userTaskLifecycle\.processDetailed\(event\)/);
  assert.match(source, /persisted\.disposition === "emitted"/);
  assert.match(source, /userTaskLifecycle\.flushPending\(\)/);
  assert.match(source, /userTasks: userTaskLifecycle\.status\(\)/);
  assert.match(source, /if \(await persistDeferredEvent\(event\)\) agentEventTelemetry\.emitted \+= 1/);
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
