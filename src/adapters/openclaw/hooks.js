import { localDiagnostic, normalizeRuntimeEvent } from "../../core/normalize.js";

export const OPENCLAW_HOOK_SOURCES = Object.freeze({
  message_received: "src/plugins/hook-message.types.ts:70",
  message_sent: "src/plugins/hook-message.types.ts:111",
  gateway_start: "src/plugins/hook-types.ts:898",
  gateway_stop: "src/plugins/hook-types.ts:902",
});

const FAILURE_CODES = new Set([
  "AUTH_FAILED", "KILLED", "NONZERO_EXIT", "NOT_FOUND", "PERMISSION_DENIED",
  "RATE_LIMITED", "TIMEOUT", "UNKNOWN", "VALIDATION_FAILED",
]);

const TURN_TERMINALS = new Set([
  "turn.completed", "turn.failed", "turn.timeout", "turn.cancelled",
]);

export function createOpenClawUserTaskLifecycle({
  cancel = clearTimeout,
  now = Date.now,
  onDeferred = () => {},
  onSuppressed = () => {},
  schedule = setTimeout,
  terminalGraceMs = 5_000,
  maxRuns = 1000,
  ttlMs = 60 * 60_000,
} = {}) {
  const runs = new Map();
  const tasksBySession = new Map();
  const taskQueue = (sessionId) => tasksBySession.get(sessionId) ?? [];
  const dequeue = (key, state) => {
    const remaining = taskQueue(state.sessionId).filter((candidate) => candidate !== key);
    if (remaining.length > 0) tasksBySession.set(state.sessionId, remaining);
    else tasksBySession.delete(state.sessionId);
  };
  const clearPending = (state, { suppressed = false } = {}) => {
    const event = state.pendingEvent;
    if (state.pendingTimer) cancel(state.pendingTimer);
    state.pendingEvent = null;
    state.pendingTimer = null;
    if (suppressed && event) onSuppressed(event);
  };
  const remove = (key) => {
    const state = runs.get(key);
    if (state?.sessionId) {
      clearPending(state, { suppressed: true });
      dequeue(key, state);
    }
    runs.delete(key);
  };
  const prune = (nowMs) => {
    for (const [key, state] of runs) {
      if (nowMs - state.updatedAt >= ttlMs) remove(key);
    }
  };
  const track = (key, state) => {
    while (runs.size >= maxRuns) remove(runs.keys().next().value);
    runs.set(key, state);
  };
  const taskKey = (sessionId, messageId) => (
    typeof sessionId === "string" && sessionId
    && typeof messageId === "string" && messageId
      ? `message:${sessionId}:${messageId}`
      : null
  );
  const runKey = (turnId) => typeof turnId === "string" && turnId ? `run:${turnId}` : null;
  const closeTask = (key, state, event, nowMs) => {
    clearPending(state, { suppressed: state.pendingEvent !== event });
    state.terminal = true;
    state.updatedAt = nowMs;
    dequeue(key, state);
    return event;
  };
  const releasePending = (key, state, nowMs) => {
    const event = state.pendingEvent;
    if (!event || state.terminal) return Promise.resolve();
    const released = closeTask(key, state, event, nowMs);
    return Promise.resolve(onDeferred(released));
  };
  const deferTerminal = (key, state, event, nowMs) => {
    clearPending(state, { suppressed: true });
    state.pendingEvent = event;
    state.updatedAt = nowMs;
    state.pendingTimer = schedule(() => {
      if (runs.get(key) !== state || state.terminal || state.pendingEvent !== event) return;
      void releasePending(key, state, now()).catch(() => {});
    }, terminalGraceMs);
    state.pendingTimer?.unref?.();
  };
  const accepted = (event) => Object.freeze({ disposition: "accepted", event });
  const buffered = () => Object.freeze({ disposition: "buffered", event: null });
  const coalesced = () => Object.freeze({ disposition: "coalesced", event: null });
  const processDetailed = (event) => {
    const nowMs = now();
    prune(nowMs);
    const correlation = event?.correlation ?? {};
    const messageKey = taskKey(correlation.sessionId, correlation.messageId);
    if (event?.type === "message.received") {
      if (!messageKey || runs.has(messageKey)) return messageKey ? coalesced() : accepted(event);
      const startsImmediately = !taskQueue(correlation.sessionId)
        .some((key) => !runs.get(key)?.terminal);
      track(messageKey, {
        createdAt: nowMs,
        messageId: correlation.messageId,
        sessionId: correlation.sessionId,
        started: startsImmediately,
        terminal: false,
        updatedAt: nowMs,
        pendingEvent: null,
        pendingTimer: null,
      });
      tasksBySession.set(correlation.sessionId, [...taskQueue(correlation.sessionId), messageKey]);
      return accepted(startsImmediately ? { ...event, type: "turn.started" } : event);
    }
    const started = event?.type === "turn.started";
    const terminal = TURN_TERMINALS.has(event?.type);
    const queue = taskQueue(correlation.sessionId);
    let activeKey = queue.find((key) => !runs.get(key)?.terminal) ?? null;
    let active = activeKey ? runs.get(activeKey) : null;
    if (!started && !terminal) {
      if (active) active.updatedAt = nowMs;
      return accepted(event);
    }
    if (started) {
      if (active?.pendingEvent && queue.some((key) => key !== activeKey && !runs.get(key)?.terminal)) {
        void releasePending(activeKey, active, nowMs).catch(() => {});
        activeKey = taskQueue(correlation.sessionId).find((key) => !runs.get(key)?.terminal) ?? null;
        active = activeKey ? runs.get(activeKey) : null;
      }
      if (active) {
        active.updatedAt = nowMs;
        if (active.pendingEvent) {
          clearPending(active, { suppressed: true });
          return coalesced();
        }
        if (active.started || active.terminal) return coalesced();
        active.started = true;
        return accepted(event);
      }
      const autonomousKey = runKey(correlation.turnId);
      if (!autonomousKey) return accepted(event);
      if (runs.has(autonomousKey)) return coalesced();
      track(autonomousKey, { createdAt: nowMs, started: true, terminal: false, updatedAt: nowMs });
      return accepted(event);
    }
    if (active) {
      active.updatedAt = nowMs;
      const deliveredResponse = Boolean(messageKey);
      if (event.type === "turn.completed" && !deliveredResponse) return coalesced();
      if (deliveredResponse && !active.started) return coalesced();
      if (active.terminal) return coalesced();
      if (!deliveredResponse) {
        deferTerminal(activeKey, active, event, nowMs);
        return buffered();
      }
      return accepted(closeTask(activeKey, active, event, nowMs));
    }
    if (messageKey) return coalesced();
    const autonomousKey = runKey(correlation.turnId);
    if (!autonomousKey) return accepted(event);
    const autonomous = runs.get(autonomousKey);
    if (autonomous?.terminal) return coalesced();
    if (autonomous) {
      autonomous.terminal = true;
      autonomous.updatedAt = nowMs;
    } else {
      track(autonomousKey, { createdAt: nowMs, started: false, terminal: true, updatedAt: nowMs });
    }
    return accepted(event);
  };
  return Object.freeze({
    process: (event) => processDetailed(event).event,
    processDetailed,
    async flushPending() {
      const pending = [...runs].filter(([, state]) => state.pendingEvent && !state.terminal);
      await Promise.all(pending.map(([key, state]) => releasePending(key, state, now())));
    },
    status: () => Object.freeze({
      pendingTerminals: [...runs.values()].filter((state) => state.pendingEvent && !state.terminal).length,
      trackedRuns: runs.size,
    }),
  });
}

function safeInteger(...values) {
  return values.find((value) => Number.isSafeInteger(value));
}

function safeOperation(...values) {
  return values.find((value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(value));
}

function classifyFailure(data, exitCode) {
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const httpStatus = safeInteger(data.httpStatus, data.statusCode, data.result?.httpStatus, data.result?.statusCode);
  const explicit = typeof data.code === "string" ? data.code.toUpperCase().replaceAll("-", "_") : "";
  if (FAILURE_CODES.has(explicit)) return explicit;
  if ([401, 403].includes(httpStatus)) return "AUTH_FAILED";
  if (httpStatus === 429) return "RATE_LIMITED";
  if (status === "timeout" || data.timedOut === true) return "TIMEOUT";
  if (["killed", "aborted", "cancelled"].includes(status)) return "KILLED";
  if (["validation_failed", "invalid", "rejected"].includes(status)) return "VALIDATION_FAILED";
  if (["not_found", "missing"].includes(status)) return "NOT_FOUND";
  if (["permission_denied", "forbidden"].includes(status)) return "PERMISSION_DENIED";
  if (Number.isSafeInteger(exitCode) && exitCode !== 0) return "NONZERO_EXIT";
  return "UNKNOWN";
}

function cancellation(data, exitCode) {
  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  return data.cancelled === true
    || data.canceled === true
    || ["killed", "aborted", "cancelled", "canceled"].includes(status)
    || [130, 143].includes(exitCode);
}

function toolDetails(data, failed, fallbackOperation) {
  const exitCode = safeInteger(data.exitCode, data.result?.exitCode);
  const httpStatus = safeInteger(data.httpStatus, data.statusCode, data.result?.httpStatus, data.result?.statusCode);
  return {
    operation: safeOperation(data.name, data.toolName, data.result?.name, data.result?.toolName, fallbackOperation) ?? "unknown",
    status: safeOperation(data.status, data.result?.status),
    exitCode,
    ...(Number.isSafeInteger(httpStatus) ? { httpStatus } : {}),
    code: failed ? classifyFailure(data, exitCode) : undefined,
    recoverable: failed ? !["AUTH_FAILED", "PERMISSION_DENIED"].includes(classifyFailure(data, exitCode)) : undefined,
  };
}

export function openClawAgentEventInput(event = {}) {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const correlation = {
    sessionId: event.sessionId,
    turnId: event.runId,
    toolCallId: data.toolCallId
      ?? data.itemId
      ?? data.approvalId
      ?? data.approvalSlug,
  };
  if (event.stream === "lifecycle") {
    if (data.phase === "start") return { kind: "turn_start", correlation };
    if (["end", "error"].includes(data.phase)) {
      const timedOut = data.timedOut === true || data.outcome === "timeout";
      const cancelled = data.aborted === true
        || ["cancelled", "canceled", "aborted", "killed"].includes(
          typeof data.stopReason === "string" ? data.stopReason.toLowerCase() : "",
        );
      return {
        kind: "turn_end",
        outcome: cancelled ? "cancelled" : timedOut ? "timeout" : data.phase === "error" || data.success === false ? "failure" : "success",
        durationMs: Number.isSafeInteger(data.durationMs) ? data.durationMs : undefined,
        correlation,
      };
    }
  }
  if (event.stream === "approval") {
    if (data.phase === "requested" && data.status === "pending") {
      return { kind: "tool_start", operation: "user_approval", correlation };
    }
    if (data.phase === "resolved") {
      return {
        kind: "tool_end",
        operation: "user_approval",
        outcome: ["denied", "failed", "unavailable"].includes(data.status)
          ? "cancelled"
          : "success",
        correlation,
      };
    }
  }
  if (event.stream === "tool") {
    if (["start", "started"].includes(data.phase)) {
      return { kind: "tool_start", operation: safeOperation(data.name, data.toolName), correlation };
    }
    if (["result", "end", "completed"].includes(data.phase)) {
      const exitCode = safeInteger(data.exitCode, data.result?.exitCode);
      const failed = data.isError === true || ["failed", "error", "timeout", "killed"].includes(data.status) ||
        (Number.isSafeInteger(exitCode) && exitCode !== 0);
      const cancelled = cancellation(data, exitCode);
      return {
        kind: "tool_end",
        outcome: cancelled ? "cancelled" : data.status === "timeout" ? "timeout" : failed ? "failure" : "success",
        durationMs: Number.isSafeInteger(data.durationMs) ? data.durationMs : undefined,
        ...toolDetails(data, failed && !cancelled),
        correlation,
      };
    }
  }
  return null;
}

export function registerOpenClawHooks(api, { emit, envelopeFactory, onDiagnostic = () => {}, maxPending = 1000 }) {
  let pending = 0;
  let emitted = 0;
  let ignored = 0;
  let lastObservedAt = null;
  const observed = {};
  const diagnostics = {};
  const diagnose = (diagnostic) => {
    diagnostics[diagnostic.code] = (diagnostics[diagnostic.code] ?? 0) + 1;
    onDiagnostic(diagnostic);
  };
  const observe = (name, makeInput) => (event = {}, ctx = {}) => {
    observed[name] = (observed[name] ?? 0) + 1;
    lastObservedAt = new Date().toISOString();
    if (pending >= maxPending) { diagnose(localDiagnostic("hook-backpressure", "openclaw")); return; }
    let input;
    try { input = makeInput(event, ctx); } catch { diagnose(localDiagnostic("hook-read-failed", "openclaw")); return; }
    pending += 1;
    queueMicrotask(async () => {
      try {
        const result = normalizeRuntimeEvent("openclaw", input, envelopeFactory(input, event, ctx));
        if (result.event) {
          const accepted = await emit(result.event);
          if (accepted === false) ignored += 1;
          else emitted += 1;
        } else if (result.diagnostic) diagnose(result.diagnostic);
      } catch { diagnose(localDiagnostic("hook-emit-failed", "openclaw")); }
      finally { pending -= 1; }
    });
  };
  const correlation = (event, ctx) => ({
    sessionId: ctx.sessionId ?? event.sessionId, turnId: ctx.runId ?? event.runId,
    toolCallId: ctx.toolCallId ?? event.toolCallId, messageId: ctx.messageId ?? event.messageId,
  });
  const hooks = {
    message_received: observe("message_received", (event, ctx) => ({ kind: "message_received", correlation: correlation(event, ctx) })),
    message_sent: observe("message_sent", (event, ctx) => ({ kind: "turn_end", outcome: event.success === false ? "failure" : "success", correlation: correlation(event, ctx) })),
    gateway_start: observe("gateway_start", () => ({ kind: "gateway_up", correlation: {} })),
    gateway_stop: observe("gateway_stop", () => ({ kind: "gateway_down", correlation: {} })),
  };
  if (typeof api.on !== "function") {
    throw new TypeError("OpenClaw typed hook API (api.on) is required");
  }
  for (const [name, handler] of Object.entries(hooks)) api.on(name, handler, { timeoutMs: 25 });
  return Object.freeze({
    hookNames: Object.keys(hooks),
    pending: () => pending,
    status: () => ({ observed: { ...observed }, emitted, ignored, pending, diagnostics: { ...diagnostics }, lastObservedAt }),
  });
}
