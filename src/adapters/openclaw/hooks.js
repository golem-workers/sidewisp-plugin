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
  now = Date.now,
  maxRuns = 1000,
  ttlMs = 60 * 60_000,
} = {}) {
  const runs = new Map();
  const prune = (nowMs) => {
    for (const [key, state] of runs) {
      if (state.terminal && nowMs - state.updatedAt >= ttlMs) runs.delete(key);
    }
  };
  const track = (key, state) => {
    while (runs.size >= maxRuns) {
      const terminalKey = [...runs].find(([, candidate]) => candidate.terminal)?.[0];
      if (!terminalKey) return false;
      runs.delete(terminalKey);
    }
    runs.set(key, state);
    return true;
  };
  const runKey = (turnId) => typeof turnId === "string" && turnId ? `run:${turnId}` : null;
  const accepted = (event) => Object.freeze({ disposition: "accepted", event });
  const coalesced = () => Object.freeze({ disposition: "coalesced", event: null });
  const processDetailed = (event) => {
    const nowMs = now();
    prune(nowMs);
    const correlation = event?.correlation ?? {};
    const started = event?.type === "turn.started";
    const terminal = TURN_TERMINALS.has(event?.type);
    if (!started && !terminal) return accepted(event);
    const key = runKey(correlation.turnId);
    if (!key) return coalesced();
    const state = runs.get(key);
    if (started) {
      if (state) return coalesced();
      if (!track(key, { started: true, terminal: false, turnId: correlation.turnId, updatedAt: nowMs })) return coalesced();
      return accepted(event);
    }
    if (state?.terminal) return coalesced();
    if (state) Object.assign(state, { terminal: true, updatedAt: nowMs });
    else track(key, { started: false, terminal: true, turnId: correlation.turnId, updatedAt: nowMs });
    return accepted(event);
  };
  const activeRunIds = () => Object.freeze(
    [...runs.values()].filter((state) => !state.terminal).map((state) => state.turnId),
  );
  return Object.freeze({
    process: (event) => processDetailed(event).event,
    processDetailed,
    rollback(event) {
      const key = runKey(event?.correlation?.turnId);
      const state = key ? runs.get(key) : null;
      if (!state) return;
      if (event?.type === "turn.started" && !state.terminal) {
        runs.delete(key);
      } else if (TURN_TERMINALS.has(event?.type) && state.terminal) {
        if (state.started) state.terminal = false;
        else runs.delete(key);
      }
    },
    activeRunIds,
    cancelActiveRuns(makeTerminalEvent) {
      const terminals = [];
      for (const turnId of activeRunIds()) {
        const result = processDetailed(makeTerminalEvent(turnId));
        if (result.disposition === "accepted") terminals.push(result.event);
      }
      return Object.freeze(terminals);
    },
    status: () => Object.freeze({
      activeRuns: [...runs.values()].filter((state) => !state.terminal).length,
      pendingTerminals: 0,
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
    sessionId: event.sessionId ?? event.sessionKey,
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
    sessionId: ctx.sessionId ?? ctx.sessionKey ?? event.sessionId ?? event.sessionKey,
    turnId: ctx.runId ?? event.runId,
    toolCallId: ctx.toolCallId ?? event.toolCallId, messageId: ctx.messageId ?? event.messageId,
  });
  const hooks = {
    message_received: observe("message_received", (event, ctx) => ({ kind: "message_received", correlation: correlation(event, ctx) })),
    message_sent: observe("message_sent", (event, ctx) => ({ kind: "delivery_end", outcome: event.success === false ? "failure" : "success", correlation: correlation(event, ctx) })),
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
