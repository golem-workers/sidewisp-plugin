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
    { sessionKey: "agent:main:telegram:group:one" },
  );
  registered.get("message_sent").handler(
    { messageId: "message-1", text: "private outbound", success: true },
    { sessionKey: "agent:main:telegram:group:one" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["message.received", "message.delivered"]);
  assert.ok(events.every(({ correlation }) => correlation.sessionId === "agent:main:telegram:group:one"));
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.deepEqual(telemetry.status().observed, { message_received: 1, message_sent: 1 });
  assert.equal(telemetry.status().emitted, 2);
});

test("an unsuccessful outgoing message reports delivery failure without changing work", async () => {
  const registered = new Map();
  const events = [];
  registerOpenClawHooks({ on: (name, handler) => registered.set(name, handler) }, { emit: async (event) => events.push(event), envelopeFactory: envelope });
  registered.get("message_sent")({ success: false, error: "raw private", messageId: "m" }, { sessionId: "s" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type, outcome }) => ({ type, outcome })), [
    { type: "message.failed", outcome: "failure" },
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
    openClawAgentEventInput({ runId: "run-1", sessionKey: "agent:main:telegram:group:one", stream: "lifecycle", data: { phase: "start" } }),
    { kind: "turn_start", correlation: { sessionId: "agent:main:telegram:group:one", turnId: "run-1", toolCallId: undefined } },
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

test("message and gateway hooks never invent work transitions", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const events = [
    { type: "message.received", correlation: { sessionId: "telegram", messageId: "inbound" } },
    { type: "message.delivered", correlation: { sessionId: "telegram", messageId: "outbound" } },
    { type: "gateway.disconnected", correlation: {} },
  ].map((event) => lifecycle.process(event)).filter(Boolean);
  assert.equal(events.filter(({ type }) => type.startsWith("turn.")).length, 0);
  assert.deepEqual(lifecycle.activeRunIds(), []);
});

test("official run id emits exactly one start and one immediate terminal", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const event = (type, turnId = "run-one") => ({ type, correlation: { turnId } });
  assert.equal(lifecycle.process({ type: "turn.started", correlation: { sessionId: "session-only" } }), null);
  assert.equal(lifecycle.process(event("turn.started")).type, "turn.started");
  assert.equal(lifecycle.process(event("turn.started")), null);
  assert.equal(lifecycle.process(event("turn.completed")).type, "turn.completed");
  assert.equal(lifecycle.process(event("turn.failed")), null);
  assert.deepEqual(lifecycle.activeRunIds(), []);
});

test("official terminal is accepted without message_sent or a prior start", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const terminal = { type: "turn.failed", correlation: { turnId: "run-ended" } };
  assert.equal(lifecycle.process(terminal), terminal);
  assert.equal(lifecycle.process(terminal), null);
});

test("deduplicates lifecycle per run id while preserving parallel runs", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const event = (type, turnId, sessionId) => ({ type, correlation: { turnId, sessionId } });
  assert.ok(lifecycle.process(event("turn.started", "run-a", "session-a")));
  assert.ok(lifecycle.process(event("turn.started", "run-b", "session-b")));
  assert.equal(lifecycle.process(event("turn.started", "run-a", "different-session")), null);
  assert.deepEqual(new Set(lifecycle.activeRunIds()), new Set(["run-a", "run-b"]));
  assert.ok(lifecycle.process(event("turn.timeout", "run-b")));
  assert.ok(lifecycle.process(event("turn.cancelled", "run-a")));
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("graceful gateway stop closes every active run once", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const start = (turnId) => ({ type: "turn.started", correlation: { turnId } });
  lifecycle.process(start("run-a"));
  lifecycle.process(start("run-b"));
  const terminals = lifecycle.cancelActiveRuns((turnId) => ({
    type: "turn.cancelled",
    correlation: { turnId },
  }));
  assert.deepEqual(terminals.map(({ correlation }) => correlation.turnId), ["run-a", "run-b"]);
  assert.equal(lifecycle.status().activeRuns, 0);
  assert.deepEqual(lifecycle.cancelActiveRuns(() => assert.fail("already closed")), []);
});

test("failed durable writes can roll lifecycle state back for an exact retry", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const started = { type: "turn.started", correlation: { turnId: "run-retry" } };
  const completed = { type: "turn.completed", correlation: { turnId: "run-retry" } };
  assert.equal(lifecycle.process(started), started);
  lifecycle.rollback(started);
  assert.equal(lifecycle.process(started), started);
  assert.equal(lifecycle.process(completed), completed);
  lifecycle.rollback(completed);
  assert.deepEqual(lifecycle.activeRunIds(), ["run-retry"]);
  assert.equal(lifecycle.process(completed), completed);
});

test("persisted active run can recover after restart with a stable terminal id", () => {
  const beforeRestart = createOpenClawUserTaskLifecycle();
  beforeRestart.process({ type: "turn.started", correlation: { turnId: "run-orphan" } });
  const stored = JSON.stringify(beforeRestart.activeRunIds());
  const terminalInput = (turnId) => ({ kind: "turn_end", outcome: "cancelled", correlation: { turnId } });
  const recovered = JSON.parse(stored).map((turnId) => ({
    type: "turn.cancelled",
    correlation: { turnId },
    eventId: stableOpenClawEventId(terminalInput(turnId)),
  }));
  assert.equal(recovered[0].eventId, stableOpenClawEventId(terminalInput("run-orphan")));
  const afterRestart = createOpenClawUserTaskLifecycle();
  assert.equal(afterRestart.process(recovered[0]).type, "turn.cancelled");
  assert.equal(afterRestart.process(recovered[0]), null);
});

test("bounds terminal dedupe state and never reads event content", () => {
  let nowMs = 1_000;
  const lifecycle = createOpenClawUserTaskLifecycle({ now: () => nowMs, maxRuns: 2, ttlMs: 50 });
  const event = (turnId) => ({
    type: "turn.started",
    correlation: { turnId },
    get details() { throw new Error("private content read"); },
  });
  assert.ok(lifecycle.process(event("run-one")));
  assert.ok(lifecycle.process({ type: "turn.completed", correlation: { turnId: "run-one" } }));
  assert.ok(lifecycle.process(event("run-two")));
  assert.ok(lifecycle.process({ type: "turn.completed", correlation: { turnId: "run-two" } }));
  assert.ok(lifecycle.process(event("run-three")));
  assert.equal(lifecycle.status().trackedRuns, 2);
  nowMs += 51;
  assert.ok(lifecycle.process(event("run-one")));
  assert.equal(lifecycle.status().activeRuns, 2);
});

test("does not silently expire an active run", () => {
  let nowMs = 1_000;
  const lifecycle = createOpenClawUserTaskLifecycle({ now: () => nowMs, ttlMs: 50 });
  assert.ok(lifecycle.process({ type: "turn.started", correlation: { turnId: "long" } }));
  nowMs += 51;
  assert.ok(lifecycle.process({ type: "tool.started", correlation: { turnId: "long", toolCallId: "tool" } }));
  assert.deepEqual(lifecycle.activeRunIds(), ["long"]);
});

test("plugin subscribes through the official host-owned agent event API", () => {
  const source = readFileSync(new URL("../src/adapters/openclaw/plugin.js", import.meta.url), "utf8");
  assert.match(source, /api\.agent\.events\.registerAgentEventSubscription/);
  assert.match(source, /streams:\s*\["lifecycle", "tool", "approval"\]/);
  assert.match(source, /userTaskLifecycle\.processDetailed\(event\)/);
  assert.match(source, /persisted\.disposition === "emitted"/);
  assert.match(source, /HOOK_EVENT_SOURCE/);
  assert.match(source, /const enqueueAcceptedEvents = \(acceptedEvents\) =>/);
  assert.doesNotMatch(source, /await enqueueAcceptedEvent/);
  assert.match(source, /hookCursor\(acceptedEvents\.at\(-1\)\.sequence, userTaskLifecycle\.activeRunIds\(\)\)/);
  assert.match(source, /\.filter\(isOpenClawHookRecoveryFact\)/);
  assert.match(source, /userTaskLifecycle\.rollback\(result\.event\)/);
  assert.match(source, /userTaskLifecycle\.cancelActiveRuns\(cancelledRunEvent\)/);
  assert.match(source, /userTasks: userTaskLifecycle\.status\(\)/);
  assert.doesNotMatch(source, /terminalGraceMs|persistDeferredEvent|flushPending/);
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
