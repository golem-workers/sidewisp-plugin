import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  createOpenClawUserTaskLifecycle,
  OPENCLAW_HOOK_SOURCES,
  openClawActiveWorkCursor,
  openClawAgentEventInput,
  parseOpenClawActiveWorkCursor,
  registerOpenClawHooks,
} from "../src/adapters/openclaw/hooks.js";
import { stableOpenClawEventId } from "../src/adapters/openclaw/recovery.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";

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
    { inboundMessageId: "message-1", text: "private inbound" },
    { sessionKey: "agent:main:telegram:group:one", sessionId: "runtime-session-uuid" },
  );
  registered.get("message_sent").handler(
    { outboundMessageId: "response-1", text: "private outbound", success: true },
    { sessionKey: "agent:main:telegram:group:one", sessionId: "runtime-session-uuid" },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["message.received", "message.delivered"]);
  assert.equal(events[0].correlation.messageId, "message-1");
  assert.equal(events[1].correlation.messageId, "response-1");
  assert.ok(events.every(({ correlation }) => correlation.sessionId === "agent:main:telegram:group:one"));
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.deepEqual(telemetry.status().observed, { message_received: 1, message_sent: 1 });
  assert.equal(telemetry.status().emitted, 2);
});

test("an unsuccessful outgoing message maps to a delivery failure boundary", async () => {
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

test("reply payload hook emits only exact final run boundaries", async () => {
  const registered = new Map();
  const events = [];
  registerOpenClawHooks({ on: (name, handler) => registered.set(name, handler) }, {
    emit: async (event) => events.push(event), envelopeFactory: envelope,
  });
  registered.get("reply_payload_sending")({ kind: "tool", runId: "run" }, { sessionKey: "s" });
  registered.get("reply_payload_sending")({
    kind: "final",
    runId: "run",
    get payload() { throw new Error("payload read"); },
  }, { sessionKey: "s" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map(({ type }) => type), ["turn.completed"]);
  assert.equal(events[0].correlation.turnId, "run");
  assert.equal(events[0].details.component, "final_reply");
});

test("hook and emitter exceptions never escape into OpenClaw", async () => {
  const registered = new Map();
  const diagnostics = [];
  const telemetry = registerOpenClawHooks({ on: (name, handler) => registered.set(name, handler) }, {
    emit: async () => { throw new Error("sink down"); }, envelopeFactory: envelope, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  assert.doesNotThrow(() => registered.get("gateway_start")({ port: 3000 }, {}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(diagnostics[0].localOnly, true);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(
    (({ emitted, ignored, failed, pending }) => ({ emitted, ignored, failed, pending }))(telemetry.status()),
    { emitted: 0, ignored: 0, failed: 1, pending: 0 },
  );
});

test("hook backpressure and read failures settle each observation once", () => {
  const backpressured = new Map();
  const backpressure = registerOpenClawHooks(
    { on: (name, handler) => backpressured.set(name, handler) },
    { emit: () => true, envelopeFactory: envelope, maxPending: 0 },
  );
  backpressured.get("gateway_start")({}, {});
  assert.deepEqual(
    (({ emitted, ignored, failed, pending }) => ({ emitted, ignored, failed, pending }))(backpressure.status()),
    { emitted: 0, ignored: 0, failed: 1, pending: 0 },
  );

  const registered = new Map();
  const unreadable = registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: () => true, envelopeFactory: envelope },
  );
  registered.get("message_received")({
    get sessionId() { throw new Error("private getter"); },
  }, {});
  assert.deepEqual(
    (({ emitted, ignored, failed, pending }) => ({ emitted, ignored, failed, pending }))(unreadable.status()),
    { emitted: 0, ignored: 0, failed: 1, pending: 0 },
  );
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

test("registers inbound ownership synchronously before a direct agent start", async () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: async (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );
  registered.get("message_received")(
    { inboundMessageId: "inbound", runId: "outer-run" },
    { sessionKey: "race" },
  );
  registered.get("before_dispatch")({}, { sessionKey: "race" });
  const started = lifecycle.process(official("turn.started", "race", "internal-run"));
  assert.equal(started.correlation.turnId, "inbound");
  assert.deepEqual(lifecycle.activeWork(), [
    {
      kind: "task", sessionId: "race", messageId: "inbound", turnId: "inbound", started: true,
      outerRunId: "outer-run", internalRunIds: ["internal-run"],
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
});

test("canonical session key coalesces internal runs with a different runtime session id", () => {
  const deferred = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
  });
  const emitted = [];
  lifecycle.process(boundary("agent:main:telegram:group:one", "inbound", "outer"));

  for (const runId of ["internal-1", "internal-2"]) {
    for (const phase of ["start", "end"]) {
      const input = openClawAgentEventInput({
        stream: "lifecycle",
        sessionKey: "agent:main:telegram:group:one",
        sessionId: "runtime-session-uuid",
        runId,
        data: {
          phase,
          success: true,
          ...(phase === "end" && runId === "internal-1"
            ? { yielded: true, livenessState: "paused", stopReason: "end_turn" }
            : {}),
        },
      });
      emitted.push(lifecycle.process(normalizeRuntimeEvent("openclaw", input, envelope()).event));
    }
  }
  emitted.push(lifecycle.process(finalReply("agent:main:telegram:group:one", "outer")));

  assert.deepEqual(
    [...emitted.filter(Boolean), ...deferred].map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "inbound"], ["turn.completed", "inbound"]],
  );
});

test("runtime message_received id owns one task across internal agent runs", () => {
  const registered = new Map();
  const persisted = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { persisted.push(event); return true; },
  });
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    {
      emit: (event) => {
        const result = lifecycle.processDetailed(event);
        if (result.disposition === "accepted") persisted.push(result.event);
        return result;
      },
      envelopeFactory: envelope,
    },
  );

  registered.get("message_received")(
    {
      id: "inbound",
      runId: "outer",
      get content() { throw new Error("content read"); },
    },
    { sessionKey: "agent:main:telegram:group:one" },
  );
  registered.get("before_dispatch")({}, { sessionKey: "agent:main:telegram:group:one" });
  assert.deepEqual(lifecycle.activeWork(), [{
    kind: "task",
    sessionId: "agent:main:telegram:group:one",
    messageId: "inbound",
    turnId: "inbound",
    started: false,
    outerRunId: "outer",
    internalRunIds: [],
  }]);
  for (const runId of ["internal-1", "internal-2"]) {
    for (const phase of ["start", "end"]) {
      const input = openClawAgentEventInput({
        stream: "lifecycle",
        sessionKey: "agent:main:telegram:group:one",
        sessionId: "runtime-session-uuid",
        runId,
        data: {
          phase,
          success: true,
          ...(phase === "end" && runId === "internal-1" ? { stopReason: "tool_calls" } : {}),
        },
      });
      const result = lifecycle.processDetailed(normalizeRuntimeEvent("openclaw", input, envelope()).event);
      if (result.disposition === "accepted") persisted.push(result.event);
    }
  }
  registered.get("reply_payload_sending")(
    { kind: "final", runId: "outer" },
    { sessionKey: "agent:main:telegram:group:one" },
  );

  assert.deepEqual(
    persisted.filter(({ type }) => type.startsWith("turn."))
      .map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "inbound"], ["turn.completed", "inbound"]],
  );
});

test("two active-memory runs in the message hook tick produce only the user task pair", () => {
  const registered = new Map();
  const persisted = [];
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    {
      emit: (event) => {
        const result = lifecycle.processDetailed(event);
        if (result.disposition === "accepted") persisted.push(result.event);
        return result;
      },
      envelopeFactory: envelope,
    },
  );

  const sessionId = "agent:main:telegram:group:real";
  registered.get("message_received")(
    { inboundMessageId: "telegram-message", runId: "outer-run" },
    { sessionKey: sessionId },
  );

  for (const runId of ["active-memory-1", "active-memory-2"]) {
    assert.equal(lifecycle.process(official("turn.started", sessionId, runId)), null);
    assert.equal(lifecycle.process(official("turn.completed", sessionId, runId)), null);
  }

  registered.get("before_dispatch")({}, { sessionKey: sessionId });
  const userStart = lifecycle.process(official("turn.started", sessionId, "main-run"));
  assert.equal(lifecycle.process(official("turn.completed", sessionId, "main-run")), null);
  registered.get("reply_payload_sending")(
    { kind: "final", runId: "outer-run" },
    { sessionKey: sessionId },
  );

  assert.deepEqual(
    [userStart, ...persisted]
      .filter((event) => event?.type.startsWith("turn."))
      .map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "telegram-message"], ["turn.completed", "telegram-message"]],
  );
});

test("confirmed active-memory embedded runs before inbound ownership are not user work", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const observed = [];
  const processRuntimeEvent = (event) => {
    const input = openClawAgentEventInput(event);
    if (!input) return;
    const normalized = normalizeRuntimeEvent("openclaw", input, envelope()).event;
    const transition = lifecycle.process(normalized);
    if (transition?.type.startsWith("turn.")) observed.push(transition);
  };
  const sessionId = "agent:main:telegram:group:real";

  for (const runId of ["active-memory-first", "active-memory-second"]) {
    processRuntimeEvent({
      stream: "lifecycle", sessionKey: `${sessionId}:active-memory:${runId}`, sessionId: runId, runId,
      data: { phase: "start" },
    });
    processRuntimeEvent({
      stream: "lifecycle", sessionKey: `${sessionId}:active-memory:${runId}`, sessionId: runId, runId,
      data: { phase: "end", success: true },
    });
  }

  lifecycle.process(boundary(sessionId, "telegram-message", "outer-run"));
  processRuntimeEvent({
    stream: "lifecycle", sessionKey: sessionId, runId: "main-run",
    data: { phase: "start" },
  });
  processRuntimeEvent({
    stream: "lifecycle", sessionKey: sessionId, runId: "main-run",
    data: { phase: "end", success: true },
  });
  observed.push(lifecycle.process(finalReply(sessionId, "main-run")));

  assert.deepEqual(
    observed.filter(Boolean).map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "telegram-message"], ["turn.completed", "telegram-message"]],
  );
});

test("an autonomous run with an active-memory-like id remains observable", () => {
  const input = openClawAgentEventInput({
    stream: "lifecycle",
    sessionKey: "agent:main:autonomous",
    sessionId: "runtime-session",
    runId: "active-memory-manual-task",
    data: { phase: "start" },
  });

  assert.equal(input.kind, "turn_start");
  assert.equal(input.correlation.turnId, "active-memory-manual-task");
});

test("an immediate message hook returns its async ownership registration", async () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  let resume;
  const blocked = new Promise((resolve) => { resume = resolve; });
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    {
      emit: async (event) => {
        await blocked;
        return lifecycle.processDetailed(event);
      },
      envelopeFactory: envelope,
    },
  );

  const registration = registered.get("message_received")(
    { inboundMessageId: "message", runId: "outer" },
    { sessionKey: "s" },
  );
  assert.ok(registration instanceof Promise);
  resume();
  await registration;
  assert.equal(lifecycle.process(official("turn.started", "s", "memory")), null);
});

test("a fast final with exact message or unique run correlation releases autonomous work", async () => {
  for (const finalCorrelation of [
    { messageId: "fast-command" },
    { runId: "different-run" },
  ]) {
    const registered = new Map();
    const lifecycle = createOpenClawUserTaskLifecycle();
    registerOpenClawHooks(
      { on: (name, handler) => registered.set(name, handler) },
      { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
    );

    await registered.get("message_received")(
      { inboundMessageId: "fast-command", runId: "command-run" },
      { sessionKey: "s" },
    );
    await registered.get("reply_payload_sending")(
      { kind: "final", ...finalCorrelation },
      { sessionKey: "s" },
    );
    await registered.get("message_received")(
      { inboundMessageId: "fast-command", runId: "command-run" },
      { sessionKey: "s" },
    );
    await registered.get("before_dispatch")({}, { sessionKey: "s" });

    const start = lifecycle.process(official("turn.started", "s", "autonomous"));
    const end = lifecycle.process(official("turn.completed", "s", "autonomous"));
    assert.deepEqual(
      [start, end].map(({ type, correlation }) => [type, correlation.turnId]),
      [["turn.started", "autonomous"], ["turn.completed", "autonomous"]],
    );
  }
});

test("an uncorrelated duplicate final cannot clear the next inbound ownership", async () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );

  await registered.get("message_received")(
    { inboundMessageId: "first", runId: "first-run" },
    { sessionKey: "s" },
  );
  await registered.get("reply_payload_sending")({ kind: "final" }, { sessionKey: "s" });
  await registered.get("message_received")(
    { inboundMessageId: "second", runId: "second-run" },
    { sessionKey: "s" },
  );
  await registered.get("reply_payload_sending")({ kind: "final" }, { sessionKey: "s" });

  assert.equal(lifecycle.process(official("turn.started", "s", "memory")), null);
  await registered.get("before_dispatch")({}, { sessionKey: "s" });
  assert.equal(
    lifecycle.process(official("turn.started", "s", "main")).correlation.turnId,
    "second",
  );
});

test("a retired mismatched final cannot clear the next inbound ownership", async () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );

  await registered.get("message_received")(
    { inboundMessageId: "first", runId: "first-run" },
    { sessionKey: "s" },
  );
  await registered.get("reply_payload_sending")(
    { kind: "final", runId: "mismatched-final" },
    { sessionKey: "s" },
  );
  await registered.get("message_received")(
    { inboundMessageId: "second", runId: "second-run" },
    { sessionKey: "s" },
  );
  await registered.get("reply_payload_sending")(
    { kind: "final", runId: "mismatched-final" },
    { sessionKey: "s" },
  );

  assert.equal(lifecycle.process(official("turn.started", "s", "memory")), null);
  await registered.get("before_dispatch")({}, { sessionKey: "s" });
  assert.equal(
    lifecycle.process(official("turn.started", "s", "main")).correlation.turnId,
    "second",
  );
});

test("a mismatched final for an older message cannot clear newer inbound ownership", async () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );

  await registered.get("message_received")(
    { inboundMessageId: "first", runId: "first-run" },
    { sessionKey: "s" },
  );
  await registered.get("message_received")(
    { inboundMessageId: "second", runId: "second-run" },
    { sessionKey: "s" },
  );
  await registered.get("reply_payload_sending")(
    { kind: "final", messageId: "first", runId: "late-first-run" },
    { sessionKey: "s" },
  );

  assert.equal(lifecycle.process(official("turn.started", "s", "memory")), null);
  await registered.get("before_dispatch")({}, { sessionKey: "s" });
  assert.equal(
    lifecycle.process(official("turn.started", "s", "main")).correlation.turnId,
    "second",
  );
});

test("observation rollback releases autonomous work", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const observation = {
    type: "message.received",
    correlation: { sessionId: "s", messageId: "message", turnId: "outer" },
    details: { component: "message_observation" },
  };
  const accepted = lifecycle.processDetailed(observation);
  lifecycle.rollback(accepted.event);

  assert.equal(
    lifecycle.process(official("turn.started", "s", "autonomous")).correlation.turnId,
    "autonomous",
  );
});

test("overlapping observation rollbacks cannot restore stale ownership", () => {
  for (const rollbackOrder of [[1, 0], [0, 1]]) {
    const lifecycle = createOpenClawUserTaskLifecycle();
    const observations = ["first", "second"].map((messageId, index) => (
      lifecycle.processDetailed({
        type: "message.received",
        correlation: { sessionId: "s", messageId, turnId: `outer-${index + 1}` },
        details: { component: "message_observation" },
      })
    ));
    for (const index of rollbackOrder) lifecycle.rollback(observations[index].event);

    assert.equal(
      lifecycle.process(official("turn.started", "s", "autonomous")).correlation.turnId,
      "autonomous",
    );
  }
});

test("committed observations do not retain an unbounded predecessor chain", () => {
  const lifecycle = createOpenClawUserTaskLifecycle({ maxRuns: 2 });
  for (let index = 0; index < 100; index += 1) {
    const observation = lifecycle.processDetailed({
      type: "message.received",
      correlation: {
        sessionId: "s",
        messageId: `message-${index}`,
        turnId: `outer-${index}`,
      },
      details: { component: "message_observation" },
    });
    lifecycle.commit(observation.event);
    assert.equal(lifecycle.status().pendingInboundObservations, 1);
    assert.equal(lifecycle.status().pendingObservationDepth, 0);
  }
});

test("dispatch rollback restores coalesced pre-dispatch runs", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const observation = {
    type: "message.received",
    correlation: { sessionId: "s", messageId: "message", turnId: "outer" },
    details: { component: "message_observation" },
  };
  const observed = lifecycle.processDetailed(observation);
  lifecycle.commit(observed.event);
  assert.equal(lifecycle.process(official("turn.started", "s", "memory")), null);
  assert.equal(lifecycle.process(official("turn.completed", "s", "memory")), null);

  const firstDispatch = lifecycle.processDetailed(boundary("s", "message", "outer"));
  lifecycle.rollback(firstDispatch.event);
  const retriedDispatch = lifecycle.processDetailed(boundary("s", "message", "outer"));
  lifecycle.commit(retriedDispatch.event);
  const started = lifecycle.process(official("turn.started", "s", "main"));

  assert.equal(started.correlation.turnId, "message");
  assert.deepEqual(lifecycle.activeWork()[0].internalRunIds, ["memory", "main"]);
});

test("pre-dispatch expiry is absolute and not extended by lifecycle noise", () => {
  let clock = 0;
  const lifecycle = createOpenClawUserTaskLifecycle({ now: () => clock, ttlMs: 10 });
  const observation = {
    type: "message.received",
    correlation: { sessionId: "s", messageId: "message", turnId: "outer" },
    details: { component: "message_observation" },
  };
  const observed = lifecycle.processDetailed(observation);
  lifecycle.commit(observed.event);
  clock = 9;
  assert.equal(lifecycle.process(official("turn.started", "s", "noise")), null);
  clock = 11;
  assert.equal(
    lifecycle.process(official("turn.started", "s", "autonomous")).correlation.turnId,
    "autonomous",
  );
});

test("latest same-session inbound replaces a stale observation without shifting later tasks", () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );

  registered.get("message_received")({ messageId: "fast-abort" }, { sessionKey: "s" });
  registered.get("message_received")({ messageId: "m1", runId: "outer-1" }, { sessionKey: "s" });
  registered.get("before_dispatch")({}, { sessionKey: "s" });
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-1")).correlation.turnId, "m1");
  registered.get("reply_payload_sending")({ kind: "final", runId: "outer-1" }, { sessionKey: "s" });

  registered.get("message_received")({ messageId: "m2", runId: "outer-2" }, { sessionKey: "s" });
  registered.get("before_dispatch")({}, { sessionKey: "s" });
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")).correlation.turnId, "m2");
});

test("pending inbound correlation stays isolated between sessions", () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );

  registered.get("message_received")({ messageId: "a" }, { sessionKey: "session-a" });
  registered.get("message_received")({ messageId: "b" }, { sessionKey: "session-b" });
  registered.get("before_dispatch")({}, { sessionKey: "session-b" });
  registered.get("before_dispatch")({}, { sessionKey: "session-a" });

  assert.equal(lifecycle.process(official("turn.started", "session-a", "inner-a")).correlation.turnId, "a");
  assert.equal(lifecycle.process(official("turn.started", "session-b", "inner-b")).correlation.turnId, "b");
});

test("final reply releases exact ownership synchronously before the next task starts", () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );
  registered.get("message_received")({ inboundMessageId: "m1", runId: "outer-1" }, { sessionKey: "s" });
  registered.get("before_dispatch")({}, { sessionKey: "s" });
  lifecycle.process(official("turn.started", "s", "inner-1"));
  registered.get("reply_payload_sending")({ kind: "final", runId: "outer-1" }, { sessionKey: "s" });
  registered.get("message_received")({ inboundMessageId: "m2", runId: "outer-2" }, { sessionKey: "s" });
  registered.get("before_dispatch")({}, { sessionKey: "s" });
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")).correlation.turnId, "m2");
});

test("missing correlation fails closed until a final uses an exact bound run", () => {
  const registered = new Map();
  const lifecycle = createOpenClawUserTaskLifecycle();
  registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: (event) => lifecycle.processDetailed(event), envelopeFactory: envelope },
  );
  registered.get("message_received")({ inboundMessageId: "m1" }, { sessionKey: "missing-run" });
  registered.get("before_dispatch")({}, { sessionKey: "missing-run" });
  lifecycle.process(official("turn.started", "missing-run", "inner"));
  registered.get("reply_payload_sending")({ kind: "final", runId: "inner" }, { sessionKey: "missing-run" });
  assert.equal(lifecycle.activeWork().length, 0);

  registered.get("before_dispatch")({}, { sessionKey: "missing-id" });
  lifecycle.process(official("turn.started", "missing-id", "autonomous"));
  assert.deepEqual(lifecycle.activeWork(), [{ kind: "run", sessionId: "missing-id", turnId: "autonomous" }]);

  registered.get("message_received")({ messageId: "observed", runId: "outer" }, { sessionKey: "mismatch" });
  registered.get("before_dispatch")({ messageId: "canonical" }, { sessionKey: "mismatch" });
  lifecycle.process(official("turn.started", "mismatch", "inner"));
  registered.get("reply_payload_sending")({ kind: "final", runId: "outer" }, { sessionKey: "mismatch" });
  assert.equal(lifecycle.activeWork().some(({ sessionId }) => sessionId === "mismatch"), true);
  registered.get("reply_payload_sending")({ kind: "final", runId: "inner" }, { sessionKey: "mismatch" });
  assert.equal(lifecycle.activeWork().some(({ sessionId }) => sessionId === "mismatch"), false);
});

test("buffered hook telemetry settles exactly once at its final outcome", async () => {
  const registered = new Map();
  const telemetry = registerOpenClawHooks(
    { on: (name, handler) => registered.set(name, handler) },
    { emit: async () => ({ disposition: "buffered" }), envelopeFactory: envelope },
  );
  registered.get("message_sent")({ messageId: "out", success: false }, { sessionKey: "s" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(telemetry.status().emitted, 0);
  assert.equal(telemetry.status().ignored, 0);
  assert.equal(telemetry.status().failed, 0);
  telemetry.settle("emitted");
  assert.equal(telemetry.status().emitted, 1);
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

test("lifecycle phase components never read private errors or messages", () => {
  for (const [phase, component] of [
    ["error", "agent_lifecycle_error"],
    ["end", "agent_lifecycle_end"],
  ]) {
    const data = {
      phase,
      success: false,
      ...(phase === "error" ? { endedAt: 123 } : {}),
      get error() { throw new Error("private error read"); },
      get messages() { throw new Error("private messages read"); },
    };
    const mapped = openClawAgentEventInput({ runId: `run-${phase}`, sessionId: "s", stream: "lifecycle", data });
    assert.equal(mapped.kind, "turn_end");
    assert.equal(mapped.outcome, "failure");
    assert.equal(mapped.component, component);
    assert.equal(mapped.status, phase === "error" ? "terminal-candidate" : undefined);
    assert.equal(JSON.stringify(mapped).includes("123"), false);
  }
});

test("maps only host-confirmed continuation markers", () => {
  for (const data of [
    {
      phase: "end", success: true, yielded: true,
      livenessState: "paused", stopReason: "end_turn",
    },
    { phase: "end", success: true, stopReason: "tool_calls" },
  ]) {
    assert.equal(openClawAgentEventInput({
      runId: "run", sessionId: "s", stream: "lifecycle", data,
    }).status, "continuation-pending");
  }
  for (const data of [
    { phase: "end", success: true, yielded: true, livenessState: "working", stopReason: "completed" },
    { phase: "end", success: true, yielded: true, livenessState: "paused", stopReason: "completed" },
    { phase: "end", success: true, yielded: false, livenessState: "paused", stopReason: "end_turn" },
    { phase: "end", success: false, stopReason: "tool_calls" },
    { phase: "end", aborted: true, stopReason: "tool_calls" },
    { phase: "end", timedOut: true, stopReason: "tool_calls" },
    { phase: "end", outcome: "timeout", stopReason: "tool_calls" },
    { phase: "end", status: "cancelled", stopReason: "tool_calls" },
    { phase: "end", status: "timed_out", stopReason: "tool_calls" },
    { phase: "end", timeoutPhase: "model", stopReason: "tool_calls" },
    { phase: "end", error: undefined, stopReason: "tool_calls" },
    { phase: "end", success: true, stopReason: "complete" },
  ]) {
    assert.equal(openClawAgentEventInput({
      runId: "run", sessionId: "s", stream: "lifecycle", data,
    }).status, undefined);
  }

  const privateError = {
    phase: "end",
    stopReason: "tool_calls",
    get error() { throw new Error("private error read"); },
  };
  assert.equal(openClawAgentEventInput({
    runId: "run", sessionId: "s", stream: "lifecycle", data: privateError,
  }).status, undefined);
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

const boundary = (sessionId, messageId, outerRunId) => ({
  type: "message.received",
  correlation: { sessionId, messageId, turnId: outerRunId },
  details: { component: "before_dispatch" },
});
const finalReply = (sessionId, runId) => ({
  type: "turn.completed",
  correlation: { sessionId, turnId: runId },
  details: { component: "final_reply" },
});
const official = (type, sessionId, turnId, details = {}) => ({
  type,
  correlation: { sessionId, turnId },
  details,
});
const manualTimers = () => {
  let clock = 0;
  let sequence = 0;
  let unrefCount = 0;
  const scheduled = new Map();
  return {
    now: () => clock,
    setTimeoutFn(fn, delayMs) {
      const handle = {
        id: ++sequence,
        unref() { unrefCount += 1; },
      };
      scheduled.set(handle, { at: clock + delayMs, fn });
      return handle;
    },
    clearTimeoutFn(handle) { scheduled.delete(handle); },
    advance(ms) {
      clock += ms;
      while (true) {
        const next = [...scheduled]
          .filter(([, timer]) => timer.at <= clock)
          .sort(([, left], [, right]) => left.at - right.at)[0];
        if (!next) break;
        scheduled.delete(next[0]);
        next[1].fn();
      }
    },
    pending: () => scheduled.size,
    unrefCount: () => unrefCount,
  };
};

test("coalesces three internal pairs and completes only on one final payload", () => {
  const observed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { observed.push(event); return true; },
  });
  observed.push(lifecycle.process(boundary("s", "message", "outer")));
  const runIds = ["internal-1", "internal-2", "internal-3"];
  for (const [index, runId] of runIds.entries()) {
    observed.push(lifecycle.process(official("turn.started", "s", runId)));
    observed.push(lifecycle.process(official(
      "turn.completed",
      "s",
      runId,
      index < runIds.length - 1 ? { status: "continuation-pending" } : {},
    )));
  }
  observed.push(lifecycle.process(finalReply("s", "outer")));
  const transitions = observed.filter((event) => event?.type.startsWith("turn."));
  assert.deepEqual(transitions.map(({ type }) => type), ["turn.started", "turn.completed"]);
  assert.deepEqual(transitions.map(({ correlation }) => correlation.turnId), ["message", "message"]);
});

test("successful lifecycle end stays pending until an exact final boundary", () => {
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  assert.equal(lifecycle.process(official("turn.completed", "s", "inner")), null);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(deferred.length, 0);
  const final = lifecycle.process(finalReply("s", "outer"));
  assert.deepEqual([final.type, final.correlation.turnId], ["turn.completed", "m"]);
  lifecycle.commit(final);
  assert.deepEqual(deferred, []);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed"]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("one inbound task coalesces unmarked internal run pairs until the final reply", () => {
  const emitted = [];
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "message", "outer"));

  emitted.push(lifecycle.process(official("turn.started", "s", "run-1")));
  emitted.push(lifecycle.process(official("turn.completed", "s", "run-1")));

  emitted.push(lifecycle.process(official("turn.started", "s", "run-2")));
  emitted.push(lifecycle.process(official("turn.completed", "s", "run-2")));
  emitted.push(lifecycle.process(finalReply("s", "run-2")));

  assert.deepEqual(
    emitted.filter(Boolean).map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "message"], ["turn.completed", "message"]],
  );
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("same-session lifecycle noise stays inside the inbound task until its final reply", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "message", "outer"));
  const userStart = lifecycle.process(official("turn.started", "s", "user-run"));
  lifecycle.process(official("turn.completed", "s", "user-run"));

  const extraStart = lifecycle.process(official("turn.started", "s", "extra-run"));
  const extraEnd = lifecycle.process(official("turn.completed", "s", "extra-run"));
  const userEnd = lifecycle.process(finalReply("s", "extra-run"));

  assert.deepEqual(
    [userStart, extraStart, extraEnd, userEnd]
      .filter(Boolean)
      .map(({ type, correlation }) => [type, correlation.turnId]),
    [
      ["turn.started", "message"],
      ["turn.completed", "message"],
    ],
  );
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("overlapping same-session lifecycle runs stay inside one inbound task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "message", "outer"));

  const start = lifecycle.process(official("turn.started", "s", "run-1"));
  assert.equal(lifecycle.process(official("turn.started", "s", "run-2")), null);
  assert.equal(lifecycle.process(official("turn.completed", "s", "run-2")), null);
  assert.equal(lifecycle.process(official("turn.completed", "s", "run-1")), null);
  const end = lifecycle.process(finalReply("s", "run-2"));

  assert.deepEqual(
    [start, end].map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "message"], ["turn.completed", "message"]],
  );
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("approval resolution and a resumed run stay inside one inbound task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "message", "outer"));

  const start = lifecycle.process(official("turn.started", "s", "run-1"));
  assert.equal(lifecycle.process(official("turn.completed", "s", "run-1")), null);
  lifecycle.process({
    type: "tool.started",
    correlation: { sessionId: "s", turnId: "run-1", toolCallId: "approval" },
    details: { operation: "user_approval" },
  });
  lifecycle.process({
    type: "tool.completed",
    correlation: { sessionId: "s", turnId: "run-1", toolCallId: "approval" },
    details: { operation: "user_approval" },
  });
  assert.equal(lifecycle.process(official("turn.started", "s", "run-2")), null);
  assert.equal(lifecycle.process(official("turn.completed", "s", "run-2")), null);
  const end = lifecycle.process(finalReply("s", "run-2"));

  assert.deepEqual(
    [start, end].map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "message"], ["turn.completed", "message"]],
  );
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("autonomous lifecycle without an inbound task remains independent", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const autonomousStart = lifecycle.process(official("turn.started", "s", "autonomous-run"));
  const autonomousEnd = lifecycle.process(official("turn.completed", "s", "autonomous-run"));

  assert.deepEqual(
    [autonomousStart, autonomousEnd].map(({ type, correlation }) => [type, correlation.turnId]),
    [
      ["turn.started", "autonomous-run"],
      ["turn.completed", "autonomous-run"],
    ],
  );
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("final reply durably closes pending internal success before the next dispatch", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  lifecycle.process(official("turn.completed", "s", "inner-1"));
  const final = lifecycle.process(finalReply("s", "outer-1"));
  lifecycle.commit(final);
  lifecycle.process(boundary("s", "m2", "outer-2"));
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")).correlation.turnId, "m2");
  assert.deepEqual(suppressed.map(({ correlation }) => correlation.turnId), ["m1"]);
  assert.deepEqual(lifecycle.activeWork(), [{
    kind: "task", sessionId: "s", messageId: "m2", turnId: "m2", started: true,
    outerRunId: "outer-2", internalRunIds: ["inner-2"],
  }]);
});

test("exact final within retry grace confirms recovery from an internal failure", () => {
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(official("turn.failed", "s", "inner"));
  const completed = lifecycle.process(finalReply("s", "outer"));
  assert.equal(completed.type, "turn.completed");
  lifecycle.commit(completed);
  assert.deepEqual(deferred, []);
  assert.deepEqual(suppressed.map(({ type, correlation }) => [type, correlation.turnId]), [["turn.failed", "m"]]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("only exact bound tool or approval activity suppresses a pending terminal", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({ onSuppressed: (event) => suppressed.push(event) });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(official("turn.completed", "s", "inner"));
  lifecycle.process({
    type: "tool.started", correlation: { sessionId: "s", turnId: "inner" },
    details: { operation: "user_approval" },
  });
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed"]);
  assert.equal(lifecycle.status().pendingTerminals, 0);

  lifecycle.process(official("turn.completed", "s", "inner"));
  lifecycle.process({
    type: "tool.completed", correlation: { sessionId: "s", turnId: "unbound" }, details: {},
  });
  assert.equal(lifecycle.status().pendingTerminals, 1);
});

test("message_sent remains observation and cannot complete a task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  assert.equal(lifecycle.process({
    type: "message.delivered", correlation: { sessionId: "s", turnId: "outer", messageId: "out" }, details: {},
  }).type, "message.delivered");
  assert.equal(lifecycle.status().activeRuns, 1);
  assert.equal(lifecycle.process(finalReply("s", "outer")).type, "turn.completed");
});

test("exact final payload and duplicates cannot close a newer task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  assert.equal(lifecycle.process(finalReply("s", "outer-1")).correlation.turnId, "m1");
  lifecycle.process(boundary("s", "m2", "outer-2"));
  lifecycle.process(official("turn.started", "s", "inner-2"));
  assert.equal(lifecycle.process(finalReply("s", "outer-1")), null);
  assert.deepEqual(lifecycle.activeWork(), [{
    kind: "task", sessionId: "s", messageId: "m2", turnId: "m2", started: true,
    outerRunId: "outer-2", internalRunIds: ["inner-2"],
  }]);
});

test("lifecycle runs stay internal when dispatch omitted trusted outer run id", () => {
  const deferred = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
  });
  lifecycle.process(boundary("s", "m"));
  assert.equal(lifecycle.process(official("turn.started", "s", "primary")).correlation.turnId, "m");
  assert.deepEqual(lifecycle.activeWork(), [{
    kind: "task", sessionId: "s", messageId: "m", turnId: "m", started: true,
    internalRunIds: ["primary"],
  }]);
  assert.equal(lifecycle.process(official("turn.failed", "s", "primary")), null);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.process(finalReply("s", "primary")).type, "turn.completed");
  assert.deepEqual(deferred, []);
});

test("two lifecycle runs without trusted outer produce one task pair on final", () => {
  const observed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { observed.push(event); return true; },
  });
  lifecycle.process(boundary("s", "m"));
  for (const runId of ["r1", "r2"]) {
    observed.push(lifecycle.process(official("turn.started", "s", runId)));
    observed.push(lifecycle.process(official(
      "turn.completed",
      "s",
      runId,
      runId === "r1" ? { status: "continuation-pending" } : {},
    )));
  }
  observed.push(lifecycle.process(finalReply("s", "r2")));
  assert.deepEqual(
    observed.filter(Boolean).map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "m"], ["turn.completed", "m"]],
  );
});

test("final without a run id fails closed until an exact final arrives", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m"));
  lifecycle.process(official("turn.started", "s", "r1"));
  lifecycle.process(official("turn.completed", "s", "r1"));
  assert.equal(lifecycle.process(finalReply("s")), null);
  assert.equal(lifecycle.status().activeRuns, 1);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  const final = lifecycle.process(finalReply("s", "r1"));
  lifecycle.commit(final);
  assert.deepEqual(suppressed.map(({ type, correlation }) => [type, correlation.turnId]), [["turn.completed", "m"]]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("late final with an old exact binding cannot close newer current task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m1"));
  lifecycle.process(official("turn.started", "s", "old-run"));
  lifecycle.process(official("turn.completed", "s", "old-run"));
  lifecycle.process(finalReply("s", "old-run"));
  lifecycle.process(boundary("s", "m2"));
  lifecycle.process(official("turn.started", "s", "new-run"));
  assert.equal(lifecycle.process(finalReply("s")), null);
  assert.equal(lifecycle.process(finalReply("s", "old-run")), null);
  assert.deepEqual(lifecycle.activeWork(), [{
    kind: "task", sessionId: "s", messageId: "m2", turnId: "m2", started: true,
    internalRunIds: ["new-run"],
  }]);
});

test("retry start suppresses first internal failure without trusted outer", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({ onSuppressed: (event) => suppressed.push(event) });
  lifecycle.process(boundary("s", "m"));
  lifecycle.process(official("turn.started", "s", "r1"));
  lifecycle.process(official("turn.failed", "s", "r1"));
  assert.equal(lifecycle.process(official("turn.started", "s", "r2")), null);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
  assert.equal(lifecycle.status().pendingTerminals, 0);
});

test("authoritative outer completion stays pending until the final reply", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "outer"));
  assert.equal(lifecycle.process(official("turn.completed", "s", "outer")), null);
  assert.equal(lifecycle.status().activeRuns, 1);
  const final = lifecycle.process(finalReply("s", "outer"));
  assert.equal(final.type, "turn.completed");
  lifecycle.commit(final);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed"]);
});

test("outer lifecycle end and continuation form one task pair before final reply", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m1", "outer-1"));
  const start = lifecycle.process(official("turn.started", "s", "outer-1"));
  assert.equal(lifecycle.process(official(
    "turn.completed", "s", "outer-1", { status: "continuation-pending" },
  )), null);
  assert.equal(lifecycle.process(official("turn.started", "s", "continuation")), null);
  lifecycle.process({
    type: "tool.started",
    correlation: { sessionId: "s", turnId: "continuation" },
    details: { operation: "user_approval" },
  });
  assert.equal(lifecycle.process(official("turn.completed", "s", "continuation")), null);
  const final = lifecycle.process(finalReply("s", "continuation"));
  lifecycle.commit(final);

  assert.deepEqual([start, final].map(({ type, correlation }) => [type, correlation.turnId]), [
    ["turn.started", "m1"], ["turn.completed", "m1"],
  ]);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed", "turn.completed"]);

  assert.equal(lifecycle.process(official("turn.started", "s", "autonomous")).correlation.turnId, "autonomous");
  assert.equal(lifecycle.process(official("turn.completed", "s", "autonomous")).correlation.turnId, "autonomous");

  lifecycle.process(boundary("s", "m2", "outer-2"));
  assert.equal(lifecycle.process(official("turn.started", "s", "outer-2")).correlation.turnId, "m2");
});

test("unmarked same-session run after internal success stays in task until final reply", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "task-run"));
  lifecycle.process(official("turn.completed", "s", "task-run"));

  assert.equal(lifecycle.process(official("turn.started", "s", "next-run")), null);
  assert.equal(lifecycle.process(official("turn.completed", "s", "next-run")), null);
  assert.equal(lifecycle.status().activeRuns, 1);
  assert.equal(lifecycle.process(finalReply("s", "next-run")).correlation.turnId, "m");
});

test("exact outer negative outcomes recover when a final payload follows within grace", () => {
  for (const terminal of ["turn.failed", "turn.timeout", "turn.cancelled"]) {
    const deferred = [];
    const lifecycle = createOpenClawUserTaskLifecycle({
      onDeferred: (event) => { deferred.push(event); return true; },
    });
    lifecycle.process(boundary(terminal, "m", "outer"));
    lifecycle.process(official("turn.started", terminal, "outer"));
    assert.equal(lifecycle.process(official(terminal, terminal, "outer")), null);
    assert.equal(lifecycle.status().pendingTerminals, 1);
    assert.equal(lifecycle.process(finalReply(terminal, "outer")).type, "turn.completed");
    assert.deepEqual(deferred, []);
  }
});

test("an exact outer failure is suppressed when the same run retries and completes", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({ onSuppressed: (event) => suppressed.push(event) });
  lifecycle.process(boundary("s", "m", "outer"));
  const emitted = [
    lifecycle.process(official("turn.started", "s", "outer")),
    lifecycle.process(official("turn.failed", "s", "outer")),
    lifecycle.process(official("turn.started", "s", "outer")),
    lifecycle.process(official("turn.completed", "s", "outer")),
    lifecycle.process(finalReply("s", "outer")),
  ].filter(Boolean);
  assert.deepEqual(emitted.map(({ type }) => type), ["turn.started", "turn.completed"]);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
});

test("untrusted lifecycle runs coalesce through normalized input until final", () => {
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  const mapped = (phase, runId, continuationPending = false) => normalizeRuntimeEvent("openclaw", openClawAgentEventInput({
    stream: "lifecycle", sessionId: "s", runId,
    data: {
      phase,
      success: true,
      ...(continuationPending
        ? { yielded: true, livenessState: "paused", stopReason: "end_turn" }
        : {}),
    },
  }), envelope()).event;
  lifecycle.process(boundary("s", "m"));
  const emitted = [
    lifecycle.process(mapped("start", "r1")),
    lifecycle.process(mapped("end", "r1", true)),
    lifecycle.process(mapped("start", "r2")),
    lifecycle.process(mapped("end", "r2")),
    lifecycle.process(finalReply("s", "r2")),
  ].filter(Boolean);
  assert.deepEqual(
    [...emitted, ...deferred].map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.started", "m"], ["turn.completed", "m"]],
  );
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed"]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("negative lifecycle end uses grace even for a trusted outer run", () => {
  const terminal = {
    type: "turn.failed", correlation: { sessionId: "s", turnId: "run" },
    details: { component: "agent_lifecycle_end" },
  };
  const untrusted = createOpenClawUserTaskLifecycle();
  untrusted.process(boundary("s", "m"));
  untrusted.process(official("turn.started", "s", "run"));
  assert.equal(untrusted.process(terminal), null);
  assert.equal(untrusted.status().pendingTerminals, 1);
  assert.equal(untrusted.status().activeRuns, 1);

  const deferred = [];
  const suppressed = [];
  const trusted = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  trusted.process(boundary("s", "m", "run"));
  trusted.process(official("turn.started", "s", "run"));
  assert.equal(trusted.process(terminal), null);
  assert.equal(trusted.status().pendingTerminals, 1);
  assert.equal(trusted.status().pendingTimers, 1);
  assert.equal(trusted.process(official("turn.started", "s", "retry")), null);
  trusted.process(official("turn.completed", "s", "retry"));
  const final = trusted.process(finalReply("s", "retry"));
  trusted.commit(final);
  assert.equal(final.type, "turn.completed");
  assert.deepEqual(deferred, []);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed", "turn.completed"]);
  assert.equal(trusted.status().activeRuns, 0);
});

test("final reply transactionally replaces an intermediate lifecycle error", () => {
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m"));
  lifecycle.process(official("turn.started", "s", "run"));
  const mapped = (phase, success) => normalizeRuntimeEvent("openclaw", openClawAgentEventInput({
    stream: "lifecycle", sessionId: "s", runId: "run", data: { phase, success },
  }), envelope()).event;
  const error = mapped("error", false);
  const end = mapped("end", true);
  assert.equal(error.eventId, end.eventId);
  lifecycle.process(error);
  assert.equal(lifecycle.process(end), null);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
  const final = lifecycle.process(finalReply("s", "run"));
  lifecycle.commit(final);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed", "turn.completed"]);
  assert.deepEqual(deferred, []);
});

test("negative lifecycle candidate settles once after the OpenClaw retry grace", () => {
  const timers = manualTimers();
  const deferred = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeferred: (event) => { deferred.push(event); return true; },
  });
  const failed = normalizeRuntimeEvent("openclaw", openClawAgentEventInput({
    stream: "lifecycle", sessionId: "s", runId: "inner",
    data: { phase: "error", endedAt: 10, success: false },
  }), envelope()).event;
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  assert.equal(lifecycle.process(failed), null);
  assert.equal(lifecycle.status().pendingTimers, 1);
  assert.equal(timers.unrefCount(), 1);

  timers.advance(14_999);
  assert.deepEqual(deferred, []);
  assert.equal(lifecycle.status().activeRuns, 1);
  timers.advance(1);
  assert.deepEqual(deferred.map(({ type, correlation }) => [type, correlation.turnId]), [["turn.failed", "m"]]);
  assert.equal(lifecycle.status().activeRuns, 0);
  assert.equal(lifecycle.status().pendingTimers, 0);
  timers.advance(60_000);
  assert.equal(deferred.length, 1);
});

test("retry start before grace suppresses failure and exact final completes once", () => {
  const timers = manualTimers();
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  const failed = {
    type: "turn.failed", correlation: { sessionId: "s", turnId: "inner-1" },
    details: { component: "agent_lifecycle_error", status: "terminal-candidate" },
  };
  lifecycle.process(boundary("s", "m", "outer"));
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-1")).type, "turn.started");
  lifecycle.process(failed);
  timers.advance(10_000);
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")), null);
  assert.equal(lifecycle.status().pendingTimers, 0);
  const completed = lifecycle.process(finalReply("s", "outer"));
  lifecycle.commit(completed);
  timers.advance(60_000);

  assert.equal(completed.type, "turn.completed");
  assert.deepEqual(deferred, []);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("final reply replaces an error candidate and cancels its timer", () => {
  const timers = manualTimers();
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  const mapped = (phase, success) => normalizeRuntimeEvent("openclaw", openClawAgentEventInput({
    stream: "lifecycle", sessionId: "s", runId: "inner",
    data: { phase, success, endedAt: 10 },
  }), envelope()).event;
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(mapped("error", false));
  assert.equal(lifecycle.process(mapped("end", true)), null);
  assert.equal(lifecycle.status().pendingTimers, 0);
  assert.equal(lifecycle.status().awaitingFinals, 1);
  timers.advance(60_000);
  assert.deepEqual(deferred, []);
  const final = lifecycle.process(finalReply("s", "outer"));
  lifecycle.commit(final);
  assert.equal(lifecycle.status().pendingTimers, 0);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed", "turn.completed"]);
});

test("pending success never expires and a later internal start remains coalesced", () => {
  const timers = manualTimers();
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  lifecycle.process(official(
    "turn.completed", "s", "inner-1", { status: "continuation-pending" },
  ));
  assert.equal(lifecycle.status().pendingTimers, 0);
  timers.advance(60_000);
  assert.deepEqual(deferred, []);
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")), null);
  lifecycle.process(official("turn.completed", "s", "inner-2"));
  const final = lifecycle.process(finalReply("s", "outer"));
  lifecycle.commit(final);
  assert.equal(final.type, "turn.completed");
  assert.deepEqual(deferred, []);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed", "turn.completed"]);
});

test("final commit cancels negative timer while rollback restores its remaining grace", () => {
  const timers = manualTimers();
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process({
    type: "turn.failed", correlation: { sessionId: "s", turnId: "inner" },
    details: { component: "agent_lifecycle_error", status: "terminal-candidate" },
  });
  timers.advance(5_000);

  const firstFinal = lifecycle.process(finalReply("s", "outer"));
  assert.equal(lifecycle.status().pendingTimers, 0);
  lifecycle.rollback(firstFinal);
  assert.equal(lifecycle.status().pendingTimers, 1);
  const committedFinal = lifecycle.process(finalReply("s", "outer"));
  lifecycle.commit(committedFinal);
  assert.equal(lifecycle.status().pendingTimers, 0);
  timers.advance(60_000);

  assert.deepEqual(deferred, []);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("failed grace write retries automatically without a new dispatch", () => {
  const timers = manualTimers();
  const deferred = [];
  let durable = false;
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    persistRetryBaseMs: 1_000,
    onDeferred: (event) => { deferred.push(event); return durable; },
  });
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  lifecycle.process({
    type: "turn.failed", correlation: { sessionId: "s", turnId: "inner-1" },
    details: { component: "agent_lifecycle_end" },
  });
  timers.advance(15_000);
  assert.equal(deferred.length, 1);
  assert.equal(lifecycle.status().activeRuns, 1);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.status().pendingTimers, 1);

  durable = true;
  timers.advance(999);
  assert.equal(deferred.length, 1);
  timers.advance(1);
  assert.equal(deferred.length, 2);
  assert.deepEqual(deferred.map(({ correlation }) => correlation.turnId), ["m1", "m1"]);
  assert.equal(lifecycle.status().activeRuns, 0);
  assert.equal(lifecycle.status().pendingTerminals, 0);
  assert.equal(lifecycle.status().pendingTimers, 0);
});

test("direct terminal enqueue rollback becomes a durable retry", () => {
  const timers = manualTimers();
  const deferred = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    persistRetryBaseMs: 1_000,
    onDeferred: (event) => { deferred.push(event); return true; },
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  const completed = lifecycle.process(finalReply("s", "outer"));
  lifecycle.rollback(completed);
  assert.equal(lifecycle.status().activeRuns, 1);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.status().pendingTimers, 1);

  timers.advance(999);
  assert.deepEqual(deferred, []);
  timers.advance(1);
  assert.deepEqual(deferred.map(({ type, correlation }) => [type, correlation.turnId]), [
    ["turn.completed", "m"],
  ]);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("late internal failure cannot replace a confirmed final awaiting persistence", () => {
  const timers = manualTimers();
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    persistRetryBaseMs: 1_000,
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  const completed = lifecycle.process(finalReply("s", "outer"));
  lifecycle.rollback(completed);

  assert.equal(lifecycle.process({
    type: "turn.failed", correlation: { sessionId: "s", turnId: "inner" },
    details: { component: "agent_lifecycle_error", status: "terminal-candidate" },
  }), null);
  timers.advance(1_000);

  assert.deepEqual(deferred.map(({ type, correlation }) => [type, correlation.turnId]), [
    ["turn.completed", "m"],
  ]);
  assert.deepEqual(suppressed, []);
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("new current task cannot receive a late exact run binding from the previous task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  lifecycle.process(boundary("s", "m2", "outer-2"));
  assert.equal(lifecycle.process(official("turn.failed", "s", "inner-1")), null);
  assert.equal(lifecycle.process(official("turn.started", "s", "new-unbound")).correlation.turnId, "m2");
});

test("slash task without lifecycle cannot capture the next task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "slash", "outer-slash"));
  assert.equal(lifecycle.process(finalReply("s", "outer-slash")), null);
  lifecycle.process(boundary("s", "next", "outer-next"));
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-next")).correlation.turnId, "next");
});

test("retry stays with task one before task two dispatches", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  lifecycle.process(official("turn.failed", "s", "inner-1"));
  assert.equal(lifecycle.process(official("turn.started", "s", "retry-1")), null);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
  lifecycle.process(boundary("s", "m2", "outer-2"));
  assert.equal(lifecycle.process(finalReply("s", "outer-1")), null);
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")).correlation.turnId, "m2");
});

test("pending failure timeout or cancellation cannot capture a later dispatched task", () => {
  for (const terminal of ["turn.failed", "turn.timeout", "turn.cancelled"]) {
    const lifecycle = createOpenClawUserTaskLifecycle();
    lifecycle.process(boundary(terminal, "m1", "outer-1"));
    lifecycle.process(official("turn.started", terminal, "inner-1"));
    lifecycle.process(official(terminal, terminal, "inner-1"));
    lifecycle.process(boundary(terminal, "m2", "outer-2"));
    assert.equal(
      lifecycle.process(official("turn.started", terminal, "unbound-next")).correlation.turnId,
      "m2",
    );
  }
});

test("same autonomous run id remains distinct across sessions", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  assert.ok(lifecycle.process(official("turn.started", "a", "same")));
  assert.ok(lifecycle.process(official("turn.started", "b", "same")));
  assert.ok(lifecycle.process(official("turn.completed", "a", "same")));
  assert.deepEqual(lifecycle.activeWork(), [{ kind: "run", sessionId: "b", turnId: "same" }]);
});

test("tuple keys keep colon-bearing task and run identities distinct", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("a:b", "c", "outer-1"));
  lifecycle.process(boundary("a", "b:c", "outer-2"));
  lifecycle.process(official("turn.started", "x:y", "z"));
  lifecycle.process(official("turn.started", "x", "y:z"));
  assert.equal(lifecycle.status().trackedRuns, 4);
  assert.equal(lifecycle.activeWork().length, 4);
  assert.equal(parseOpenClawActiveWorkCursor(openClawActiveWorkCursor(1, [
    { kind: "task", sessionId: "a:b", messageId: "c", turnId: "c" },
    { kind: "task", sessionId: "a", messageId: "b:c", turnId: "b:c" },
  ])).length, 2);
});

test("failed deferred terminal write keeps exact task and crash cursor active", () => {
  const timers = manualTimers();
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    onDeferred: () => false,
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(official("turn.failed", "s", "inner"));
  timers.advance(15_000);
  const parsed = parseOpenClawActiveWorkCursor(openClawActiveWorkCursor(9, lifecycle.activeWork()));
  assert.deepEqual(parsed, [{
    kind: "task", sessionId: "s", messageId: "m", turnId: "m", started: true,
    outerRunId: "outer", internalRunIds: ["inner"],
  }]);
  assert.equal(lifecycle.status().pendingTerminals, 1);
});

test("flush attempts each pending terminal once and leaves failed writes active", async () => {
  let attempts = 0;
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: () => { attempts += 1; return false; },
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(official("turn.failed", "s", "inner"));
  assert.equal(attempts, 0);
  await lifecycle.flushPending();
  assert.equal(attempts, 1);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.status().activeRuns, 1);
});

test("shutdown cancels a task that never reached a final reply", async () => {
  const deferred = [];
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(official("turn.completed", "s", "inner"));
  assert.equal(lifecycle.status().awaitingFinals, 1);
  await lifecycle.flushPending();
  assert.deepEqual(deferred, []);
  const cancelled = lifecycle.cancelActiveRuns((turnId, sessionId) => ({
    type: "turn.cancelled", correlation: { turnId, sessionId }, details: {},
  }));
  assert.deepEqual(cancelled.map(({ type, correlation }) => [type, correlation.turnId]), [
    ["turn.cancelled", "m"],
  ]);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed"]);
  assert.equal(lifecycle.status().awaitingFinals, 0);
});

test("next inbound closes a no-reply success before opening the new task", () => {
  const deferred = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: (event) => { deferred.push(event); return true; },
  });
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  lifecycle.process(official("turn.completed", "s", "inner-1"));
  assert.equal(lifecycle.status().awaitingFinals, 1);

  assert.ok(lifecycle.process(boundary("s", "m2", "outer-2")));
  assert.deepEqual(deferred.map(({ type, correlation }) => [type, correlation.turnId]), [
    ["turn.completed", "m1"],
  ]);
  assert.deepEqual(lifecycle.activeWork().map(({ messageId }) => messageId), ["m2"]);
});

test("shutdown preserves the original pending terminal after failed flush", async () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    onDeferred: () => false,
    onSuppressed: (event) => suppressed.push(event),
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "inner"));
  lifecycle.process(official("turn.timeout", "s", "inner"));
  await lifecycle.flushPending();
  assert.equal(lifecycle.status().pendingTimers, 1);
  const cancelled = lifecycle.cancelActiveRuns((turnId, sessionId) => ({
    type: "turn.cancelled", correlation: { turnId, sessionId }, details: {},
  }));
  assert.equal(cancelled.length, 0);
  assert.deepEqual(suppressed, []);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.status().activeRuns, 1);
  assert.equal(lifecycle.status().pendingTimers, 1);
});

test("direct terminal rollback restores current ownership when no task replaced it", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  const terminal = lifecycle.process(finalReply("s", "outer-1"));
  lifecycle.rollback(terminal);
  const retried = lifecycle.process(finalReply("s", "outer-1"));
  lifecycle.commit(retried);
  assert.equal(retried.type, "turn.completed");
  assert.equal(lifecycle.status().activeRuns, 0);
  lifecycle.process(boundary("s", "m2", "outer-2"));
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-2")).correlation.turnId, "m2");
});

test("confirmed recovery survives final rollback and settles after commit", () => {
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({ onSuppressed: (event) => suppressed.push(event) });
  const lifecycleError = {
    type: "turn.failed", correlation: { sessionId: "s", turnId: "outer" },
    details: { component: "agent_lifecycle_error" },
  };
  const lifecycleEnd = () => ({
    type: "turn.completed", correlation: { sessionId: "s", turnId: "outer" },
    details: { component: "agent_lifecycle_end" },
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "outer"));
  lifecycle.process(lifecycleError);
  assert.equal(lifecycle.process(lifecycleEnd()), null);
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.failed"]);
  const rolledBack = lifecycle.process(finalReply("s", "outer"));
  lifecycle.rollback(rolledBack);
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.status().awaitingFinals, 1);

  const committed = lifecycle.process(finalReply("s", "outer"));
  lifecycle.commit(committed);
  lifecycle.commit(committed);
  assert.deepEqual(
    suppressed.map(({ type, correlation }) => [type, correlation.turnId]),
    [["turn.failed", "m"], ["turn.completed", "m"]],
  );
  assert.equal(lifecycle.status().activeRuns, 0);
});

test("before_dispatch rollback restores the previous current task", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  lifecycle.process(boundary("s", "m1", "outer-1"));
  lifecycle.process(official("turn.started", "s", "inner-1"));
  const replacement = lifecycle.process(boundary("s", "m2", "outer-2"));
  lifecycle.rollback(replacement);
  assert.equal(lifecycle.process(official("turn.started", "s", "inner-1")), null);
  assert.deepEqual(lifecycle.activeWork(), [{
    kind: "task", sessionId: "s", messageId: "m1", turnId: "m1", started: true,
    outerRunId: "outer-1", internalRunIds: ["inner-1"],
  }]);

  const bounded = createOpenClawUserTaskLifecycle({ maxRuns: 1 });
  bounded.process(boundary("s", "m1", "outer-1"));
  const boundedReplacement = bounded.process(boundary("s", "m2", "outer-2"));
  assert.equal(boundedReplacement.correlation.messageId, "m2");
  assert.deepEqual(bounded.activeWork().map(({ messageId }) => messageId), ["m2"]);
  bounded.rollback(boundedReplacement);
  assert.deepEqual(bounded.activeWork().map(({ messageId }) => messageId), ["m1"]);
});

test("full tracker can retry replacement after a pending flush failure", () => {
  let durable = false;
  const deferred = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    maxRuns: 1,
    onDeferred: (event) => { deferred.push(event); return durable; },
  });
  lifecycle.process(boundary("s", "m1"));
  lifecycle.process(official("turn.started", "s", "run"));
  lifecycle.process(official("turn.completed", "s", "run"));
  const replacement = boundary("s", "m2");
  assert.equal(lifecycle.process(replacement), null);
  assert.deepEqual(lifecycle.activeWork().map(({ messageId }) => messageId), ["m1"]);
  durable = true;
  assert.equal(lifecycle.process(replacement), replacement);
  assert.deepEqual(lifecycle.activeWork().map(({ messageId }) => messageId), ["m2"]);
  assert.deepEqual(deferred.map(({ correlation }) => correlation.turnId), ["m1", "m1"]);
});

test("same-session replacement frees its slot in a full active tracker", () => {
  const lifecycle = createOpenClawUserTaskLifecycle({ maxRuns: 2 });
  lifecycle.process(boundary("s1", "m1", "outer-1"));
  lifecycle.process(boundary("s2", "m2", "outer-2"));
  assert.ok(lifecycle.process(boundary("s1", "m3", "outer-3")));
  assert.deepEqual(
    lifecycle.activeWork().map(({ sessionId, messageId }) => [sessionId, messageId]),
    [["s2", "m2"], ["s1", "m3"]],
  );
  assert.equal(lifecycle.status().trackedRuns, 2);
});

test("rollback removes an autonomous terminal-only recovery record", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const terminal = lifecycle.process(official("turn.failed", "s", "orphan"));
  lifecycle.rollback(terminal);
  assert.equal(lifecycle.status().trackedRuns, 0);
  assert.deepEqual(lifecycle.activeWork(), []);
});

test("rollback removes an autonomous start so its retry is accepted", () => {
  const lifecycle = createOpenClawUserTaskLifecycle();
  const start = lifecycle.process(official("turn.started", "s", "retryable"));
  lifecycle.rollback(start);
  assert.equal(lifecycle.status().trackedRuns, 0);
  assert.ok(lifecycle.process(official("turn.started", "s", "retryable")));
});

test("cursor parses legacy runs and preserves task run ownership", () => {
  const parsed = parseOpenClawActiveWorkCursor(openClawActiveWorkCursor(3, [{
    kind: "task", sessionId: "s", messageId: "m", turnId: "m", started: true,
    outerRunId: "outer", internalRunIds: ["inner"],
  }]));
  assert.equal(parsed[0].outerRunId, "outer");
  assert.deepEqual(parsed[0].internalRunIds, ["inner"]);
  assert.deepEqual(parseOpenClawActiveWorkCursor(JSON.stringify(["legacy"])), [
    { kind: "run", turnId: "legacy" },
  ]);
});

test("exact activity refreshes durable tombstone TTL", () => {
  let now = 0;
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: () => now,
    ttlMs: 100,
  });
  lifecycle.process(boundary("s", "m", "outer"));
  lifecycle.process(official("turn.started", "s", "outer"));
  lifecycle.process(official("turn.completed", "s", "outer"));
  now = 80;
  lifecycle.process(finalReply("s", "outer"));
  now = 150;
  lifecycle.process({ type: "gateway.connected", correlation: {}, details: {} });
  assert.equal(lifecycle.status().trackedRuns, 1);
  now = 181;
  lifecycle.process({ type: "gateway.connected", correlation: {}, details: {} });
  assert.equal(lifecycle.status().trackedRuns, 0);
});

test("active pending task survives beyond TTL and final reply completes its pair", () => {
  let now = 0;
  const suppressed = [];
  const lifecycle = createOpenClawUserTaskLifecycle({
    now: () => now,
    onSuppressed: (event) => suppressed.push(event),
    ttlMs: 100,
  });
  lifecycle.process(boundary("s", "m"));
  lifecycle.process(official("turn.started", "s", "r1"));
  lifecycle.process(official("turn.completed", "s", "r1"));
  now = 1_000;
  lifecycle.process({ type: "gateway.connected", correlation: {}, details: {} });
  assert.equal(lifecycle.status().pendingTerminals, 1);
  assert.equal(lifecycle.status().activeRuns, 1);
  const final = lifecycle.process(finalReply("s", "r1"));
  lifecycle.commit(final);
  assert.equal(final.type, "turn.completed");
  assert.deepEqual(suppressed.map(({ type }) => type), ["turn.completed"]);
});

test("bounded tracker evicts only durable terminals and never reads content", () => {
  const lifecycle = createOpenClawUserTaskLifecycle({ maxRuns: 2 });
  const privateBoundary = {
    ...boundary("s1", "m1", "outer-1"),
    get content() { throw new Error("content read"); },
  };
  assert.ok(lifecycle.process(privateBoundary));
  assert.ok(lifecycle.process(boundary("s2", "m2", "outer-2")));
  assert.equal(lifecycle.process(boundary("s3", "m3", "outer-3")), null);
  assert.equal(lifecycle.process(official("turn.completed", "s1", "outer-1")), null);
  assert.equal(lifecycle.process(finalReply("s1", "outer-1")), null);
  assert.ok(lifecycle.process(boundary("s3", "m3", "outer-3")));
  assert.equal(lifecycle.status().trackedRuns, 2);
});

test("plugin subscribes through the official host-owned agent event API", () => {
  const source = readFileSync(new URL("../src/adapters/openclaw/plugin.js", import.meta.url), "utf8");
  assert.match(source, /api\.agent\.events\.registerAgentEventSubscription/);
  assert.match(source, /streams:\s*\["lifecycle", "tool", "approval"\]/);
  assert.match(source, /userTaskLifecycle\.processDetailed\(event\)/);
  assert.match(source, /userTaskLifecycle\.commit\(result\.event\)/);
  assert.match(source, /persisted\.disposition === "emitted"/);
  assert.match(source, /HOOK_EVENT_SOURCE/);
  assert.match(source, /const enqueueAcceptedEvents = \(acceptedEvents\) =>/);
  assert.doesNotMatch(source, /await enqueueAcceptedEvent/);
  assert.match(source, /openClawActiveWorkCursor\(acceptedEvents\.at\(-1\)\.sequence, userTaskLifecycle\.activeWork\(\)\)/);
  assert.match(source, /\.filter\(isOpenClawHookRecoveryFact\)/);
  assert.match(source, /userTaskLifecycle\.rollback\(result\.event\)/);
  assert.match(source, /userTaskLifecycle\.cancelActiveRuns\(cancelledRunEvent\)/);
  assert.match(source, /userTasks: userTaskLifecycle\.status\(\)/);
  assert.match(source, /persistDeferredEvent/);
  assert.match(source, /userTaskLifecycle\.flushPending\(\)/);
  assert.match(source, /closeActiveRuns = async[\s\S]*?await userTaskLifecycle\.flushPending\(\)[\s\S]*?userTaskLifecycle\.cancelActiveRuns/);
  assert.match(source, /if \(!spool\) return false/);
  assert.doesNotMatch(source, /preStartEvents|acceptsPreStartEvents/);
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
