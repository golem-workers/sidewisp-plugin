import { localDiagnostic, normalizeRuntimeEvent } from "../../core/normalize.js";

export const OPENCLAW_HOOK_SOURCES = Object.freeze({
  before_dispatch: "src/plugins/hook-types.ts:before_dispatch",
  reply_payload_sending: "src/plugins/hook-types.ts:reply_payload_sending",
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
const NEGATIVE_TURN_TERMINALS = new Set([
  "turn.failed", "turn.timeout", "turn.cancelled",
]);
const AGENT_RUN_TERMINAL_RETRY_GRACE_MS = 15_000;

const safeCursorId = (value) => (
  typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null
);

export function parseOpenClawActiveWorkCursor(value) {
  try {
    const parsed = JSON.parse(value ?? "null");
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.activeWork)
        ? parsed.activeWork
        : Array.isArray(parsed?.activeRunIds)
          ? parsed.activeRunIds
          : [];
    const seen = new Set();
    const activeWork = [];
    for (const candidate of raw) {
      const legacyTurnId = safeCursorId(candidate);
      const kind = legacyTurnId ? "run" : candidate?.kind;
      const turnId = legacyTurnId ?? safeCursorId(candidate?.turnId ?? candidate?.messageId);
      const sessionId = safeCursorId(candidate?.sessionId);
      const messageId = safeCursorId(candidate?.messageId);
      if (!turnId || (kind !== "run" && kind !== "task")) continue;
      if (kind === "task" && (!sessionId || !messageId)) continue;
      const identity = JSON.stringify(kind === "task"
        ? ["task", sessionId, messageId]
        : ["run", sessionId ?? "", turnId]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      activeWork.push(Object.freeze({
        kind,
        turnId,
        ...(kind === "task"
          ? {
              sessionId,
              messageId,
              started: candidate.started === true,
              ...(safeCursorId(candidate.outerRunId) ? { outerRunId: candidate.outerRunId } : {}),
              internalRunIds: [...new Set(
                (Array.isArray(candidate.internalRunIds) ? candidate.internalRunIds : [])
                  .map(safeCursorId)
                  .filter(Boolean),
              )].slice(0, 64),
            }
          : sessionId ? { sessionId } : {}),
      }));
      if (activeWork.length >= 1000) break;
    }
    return Object.freeze(activeWork);
  } catch {
    return Object.freeze([]);
  }
}

export function openClawActiveWorkCursor(sequence, activeWork) {
  return JSON.stringify({ version: 2, sequence, activeWork });
}

export function createOpenClawUserTaskLifecycle({
  now = Date.now,
  onDeferred = () => true,
  onSuppressed = () => {},
  maxRuns = 1000,
  ttlMs = 60 * 60_000,
  terminalRetryGraceMs = AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  persistRetryBaseMs = 1_000,
  persistRetryMaxMs = 60_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const records = new Map();
  const bindings = new Map();
  const retiredBindings = new Set();
  const currentBySession = new Map();
  const taskKey = (sessionId, messageId) => sessionId && messageId
    ? JSON.stringify(["task", sessionId, messageId])
    : null;
  const runKey = (sessionId, runId) => runId
    ? JSON.stringify(["run", sessionId ?? "", runId])
    : null;
  const retarget = (event, state) => {
    const descriptors = Object.getOwnPropertyDescriptors(event);
    delete descriptors.correlation;
    const copy = Object.defineProperties({}, descriptors);
    Object.defineProperty(copy, "correlation", {
      enumerable: true,
      value: Object.freeze({ ...(event?.correlation ?? {}), sessionId: state.sessionId, turnId: state.turnId }),
    });
    return Object.freeze(copy);
  };
  const accepted = (event) => Object.freeze({ disposition: "accepted", event });
  const buffered = () => Object.freeze({ disposition: "buffered", event: null });
  const coalesced = () => Object.freeze({ disposition: "coalesced", event: null });
  const clearCurrent = (key, state) => {
    if (state.kind === "task" && currentBySession.get(state.sessionId) === key) {
      currentBySession.delete(state.sessionId);
    }
  };
  const clearPendingTimer = (state) => {
    if (state.pendingTimer == null) return;
    clearTimeoutFn(state.pendingTimer);
    state.pendingTimer = null;
  };
  const clearPending = (state, suppressed = false) => {
    const pending = state.pendingTerminal;
    clearPendingTimer(state);
    state.pendingTerminal = null;
    state.pendingRetryable = false;
    state.pendingAwaitingFinal = false;
    state.pendingConfirmed = false;
    state.pendingPersistAttempts = 0;
    state.pendingDeadline = null;
    if (suppressed && pending) onSuppressed(pending);
  };
  const remove = (key) => {
    const state = records.get(key);
    if (!state) return;
    clearPending(state, true);
    clearCurrent(key, state);
    for (const [binding, owner] of bindings) if (owner === key) bindings.delete(binding);
    records.delete(key);
  };
  const prune = (nowMs) => {
    for (const [key, state] of records) {
      if (state.terminal && state.durable && nowMs - state.updatedAt >= ttlMs) remove(key);
    }
  };
  const track = (key, state) => {
    while (records.size >= maxRuns) {
      const evictable = [...records].find(([, candidate]) => candidate.terminal && candidate.durable)?.[0];
      if (!evictable) return false;
      remove(evictable);
    }
    records.set(key, state);
    return true;
  };
  const bind = (state, key, runId) => {
    const binding = runKey(state.sessionId, runId);
    if (!binding) return;
    if (bindings.has(binding)) bindings.delete(binding);
    while (bindings.size >= maxRuns) bindings.delete(bindings.keys().next().value);
    bindings.set(binding, key);
    if (state.kind === "task" && runId !== state.outerRunId && !state.internalRunIds.includes(runId)) {
      state.internalRunIds.push(runId);
      if (state.internalRunIds.length > 64) state.internalRunIds.shift();
    }
  };
  const rememberRetired = (state) => {
    for (const runId of [...state.internalRunIds, state.outerRunId].filter(Boolean)) {
      const binding = runKey(state.sessionId, runId);
      retiredBindings.delete(binding);
      while (retiredBindings.size >= maxRuns) retiredBindings.delete(retiredBindings.values().next().value);
      retiredBindings.add(binding);
    }
  };
  const forgetRetired = (state) => {
    for (const runId of [...state.internalRunIds, state.outerRunId].filter(Boolean)) {
      retiredBindings.delete(runKey(state.sessionId, runId));
    }
  };
  const taskForRun = (sessionId, runId) => {
    if (!runId) return [null, null];
    const identity = runKey(sessionId, runId);
    const bound = bindings.get(identity);
    if (bound && records.get(bound)?.kind === "task") return [bound, records.get(bound)];
    const found = [...records].find(([, state]) => state.kind === "task"
      && state.sessionId === sessionId
      && (state.outerRunId === runId || state.internalRunIds.includes(runId)));
    return found ?? (retiredBindings.has(identity) ? [identity, null] : [null, null]);
  };
  const currentTask = (sessionId) => {
    const key = currentBySession.get(sessionId);
    const state = key ? records.get(key) : null;
    return state && !state.terminal ? [key, state] : [null, null];
  };
  const attemptPending = (key, state) => {
    const event = state.pendingTerminal;
    if (!event || state.terminal || records.get(key) !== state) return false;
    clearPendingTimer(state);
    state.pendingAwaitingFinal = false;
    state.pendingConfirmed = true;
    state.terminal = true;
    state.durable = true;
    state.terminalEvent = event;
    let persisted = false;
    try { persisted = onDeferred(event) === true; } catch { persisted = false; }
    if (persisted) {
      state.pendingTerminal = null;
      state.pendingRetryable = false;
      state.pendingConfirmed = false;
      state.pendingPersistAttempts = 0;
      state.pendingDeadline = null;
      clearCurrent(key, state);
      return true;
    }
    state.terminal = false;
    state.durable = false;
    state.terminalEvent = null;
    state.pendingPersistAttempts += 1;
    const exponent = Math.min(16, Math.max(0, state.pendingPersistAttempts - 1));
    state.pendingDeadline = now() + Math.min(
      persistRetryMaxMs,
      persistRetryBaseMs * (2 ** exponent),
    );
    schedulePending(key, state);
    return false;
  };
  const schedulePending = (key, state) => {
    clearPendingTimer(state);
    if (!state.pendingTerminal || state.pendingDeadline === null) return;
    const delayMs = Math.max(0, state.pendingDeadline - now());
    const timer = setTimeoutFn(() => {
      if (state.pendingTimer !== timer) return;
      state.pendingTimer = null;
      attemptPending(key, state);
    }, delayMs);
    timer?.unref?.();
    state.pendingTimer = timer;
  };
  const isRetryableNegative = (event) => {
    if (!NEGATIVE_TURN_TERMINALS.has(event?.type)) return false;
    const component = event?.details?.component;
    return component !== "agent_lifecycle_error"
      || event?.details?.status === "terminal-candidate";
  };
  const deferTerminal = (key, state, event, nowMs) => {
    if (state.pendingConfirmed) return false;
    if (
      state.pendingTerminal
      && state.pendingTerminal.type !== "turn.completed"
      && event?.details?.component !== "agent_lifecycle_end"
    ) return false;
    clearPending(state, true);
    state.pendingTerminal = retarget(event, state);
    state.pendingRetryable = NEGATIVE_TURN_TERMINALS.has(event?.type);
    state.pendingAwaitingFinal = event?.type === "turn.completed";
    state.pendingConfirmed = false;
    state.pendingPersistAttempts = 0;
    state.pendingDeadline = isRetryableNegative(event)
      ? nowMs + terminalRetryGraceMs
      : null;
    state.updatedAt = nowMs;
    schedulePending(key, state);
    return true;
  };
  const complete = (key, state, event, nowMs) => {
    state.replacedPending = state.pendingTerminal !== event && state.pendingTerminal
      ? {
          event: state.pendingTerminal,
          retryable: state.pendingRetryable,
          awaitingFinal: state.pendingAwaitingFinal,
          confirmed: state.pendingConfirmed,
          persistAttempts: state.pendingPersistAttempts,
          deadline: state.pendingDeadline,
        }
      : null;
    clearPendingTimer(state);
    state.pendingTerminal = null;
    state.pendingRetryable = false;
    state.pendingAwaitingFinal = false;
    state.pendingConfirmed = false;
    state.pendingPersistAttempts = 0;
    state.pendingDeadline = null;
    state.terminal = true;
    state.durable = true;
    state.terminalEvent = event;
    state.updatedAt = nowMs;
    clearCurrent(key, state);
    return event;
  };
  const retire = (key, state, nowMs) => {
    clearPending(state, true);
    state.terminal = true;
    state.durable = true;
    state.terminalEvent = null;
    state.updatedAt = nowMs;
    clearCurrent(key, state);
  };
  const snapshotTask = (state) => ({
    ...state,
    internalRunIds: [...state.internalRunIds],
    previousOnRollback: null,
  });
  const restorePrevious = (transition) => {
    if (!transition) return;
    let previous = records.get(transition.key);
    if (!previous && transition.snapshot) {
      previous = transition.snapshot;
      if (!track(transition.key, previous)) return;
      forgetRetired(previous);
      bind(previous, transition.key, previous.outerRunId);
      for (const runId of previous.internalRunIds) bind(previous, transition.key, runId);
    }
    if (!previous) return;
    if (!previous.terminal) currentBySession.set(previous.sessionId, transition.key);
  };
  const processDetailed = (event) => {
    const nowMs = now();
    prune(nowMs);
    const correlation = event?.correlation ?? {};
    const component = event?.details?.component;
    if (event?.type === "message.received" && component === "before_dispatch") {
      const key = taskKey(correlation.sessionId, correlation.messageId);
      if (!key || records.has(key)) return coalesced();
      const previousKey = currentBySession.get(correlation.sessionId);
      const previous = previousKey ? records.get(previousKey) : null;
      const state = {
        kind: "task", sessionId: correlation.sessionId, messageId: correlation.messageId,
        turnId: correlation.messageId, outerRunId: correlation.turnId,
        internalRunIds: [], started: false, terminal: false, durable: false,
        pendingTerminal: null, pendingRetryable: false, pendingAwaitingFinal: false,
        pendingConfirmed: false,
        pendingPersistAttempts: 0, pendingDeadline: null, pendingTimer: null,
        registrationEvent: event, startEvent: null, terminalEvent: null,
        previousOnRollback: null,
        staged: true,
        updatedAt: nowMs,
      };
      if (previous && !previous.terminal) {
        if (previous.pendingTerminal) {
          if (attemptPending(previousKey, previous)) {
            rememberRetired(previous);
            remove(previousKey);
          } else {
            state.previousOnRollback = { key: previousKey, retired: false };
            clearCurrent(previousKey, previous);
          }
        } else {
          const snapshot = snapshotTask(previous);
          retire(previousKey, previous, nowMs);
          rememberRetired(snapshot);
          remove(previousKey);
          state.previousOnRollback = { key: previousKey, snapshot };
        }
      }
      if (!track(key, state)) {
        restorePrevious(state.previousOnRollback);
        return coalesced();
      }
      currentBySession.set(state.sessionId, key);
      bind(state, key, state.outerRunId);
      state.staged = false;
      return accepted(event);
    }
    if (component === "final_reply" && event?.type === "turn.completed") {
      if (!correlation.turnId) return coalesced();
      const [key, state] = taskForRun(correlation.sessionId, correlation.turnId);
      if (!state) return coalesced();
      state.updatedAt = nowMs;
      if (state.terminal) return coalesced();
      if (!state.started) {
        state.terminal = true;
        state.durable = true;
        state.updatedAt = nowMs;
        clearCurrent(key, state);
        return coalesced();
      }
      return accepted(complete(key, state, retarget(event, state), nowMs));
    }
    const started = event?.type === "turn.started";
    const terminal = TURN_TERMINALS.has(event?.type);
    if (!started && !terminal) {
      if (event?.type?.startsWith("tool.")) {
        const [, state] = taskForRun(correlation.sessionId, correlation.turnId);
        if (state) {
          state.updatedAt = nowMs;
          if (state.pendingTerminal && !state.pendingConfirmed && !state.terminal) clearPending(state, true);
        }
      }
      return accepted(event);
    }
    let [key, state] = taskForRun(correlation.sessionId, correlation.turnId);
    if (!state && !key && started) {
      const [candidateKey, candidate] = currentTask(correlation.sessionId);
      const claimsFirstRun = candidate && !candidate.started;
      const claimsRetry = candidate?.pendingRetryable === true;
      const claimsContinuation = candidate?.pendingAwaitingFinal === true
        && candidate.pendingTerminal?.details?.status === "continuation-pending";
      if (claimsFirstRun || claimsRetry || claimsContinuation) {
        [key, state] = [candidateKey, candidate];
      }
    }
    if (state) {
      state.updatedAt = nowMs;
      if (state.terminal) return coalesced();
      bind(state, key, correlation.turnId);
      if (started) {
        if (state.started) {
          if (state.pendingTerminal && !state.pendingConfirmed) clearPending(state, true);
          return coalesced();
        }
        state.started = true;
        state.startEvent = retarget(event, state);
        return accepted(state.startEvent);
      }
      if (!state.started) return coalesced();
      return deferTerminal(key, state, event, nowMs) ? buffered() : coalesced();
    }
    if (key) return coalesced();
    const autonomousKey = runKey(correlation.sessionId, correlation.turnId);
    if (!autonomousKey) return coalesced();
    const autonomous = records.get(autonomousKey);
    if (started) {
      if (autonomous) {
        autonomous.updatedAt = nowMs;
        return coalesced();
      }
      if (!track(autonomousKey, {
        kind: "run", sessionId: correlation.sessionId, turnId: correlation.turnId,
        terminal: false, durable: false, startEvent: event, terminalEvent: null, updatedAt: nowMs,
      })) return coalesced();
      return accepted(event);
    }
    if (autonomous?.terminal) {
      autonomous.updatedAt = nowMs;
      return coalesced();
    }
    if (autonomous) Object.assign(autonomous, { terminal: true, durable: true, terminalEvent: event, updatedAt: nowMs });
    else if (!track(autonomousKey, {
      kind: "run", sessionId: correlation.sessionId, turnId: correlation.turnId,
      terminal: true, durable: true, startEvent: null, terminalEvent: event, updatedAt: nowMs,
    })) return coalesced();
    return accepted(event);
  };
  const activeWork = () => Object.freeze([...records.values()]
    .filter((state) => !state.staged && (!state.terminal || !state.durable))
    .map((state) => Object.freeze(state.kind === "task" ? {
      kind: "task", sessionId: state.sessionId, messageId: state.messageId,
      turnId: state.turnId, started: state.started,
      ...(state.outerRunId ? { outerRunId: state.outerRunId } : {}),
      internalRunIds: [...state.internalRunIds],
    } : {
      kind: "run", turnId: state.turnId, ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    })));
  const activeRunIds = () => Object.freeze(activeWork().map((state) => state.turnId));
  return Object.freeze({
    process: (event) => processDetailed(event).event,
    processDetailed,
    commit(event) {
      const state = [...records.values()].find((candidate) => candidate.registrationEvent === event
        || candidate.terminalEvent === event);
      if (!state) return;
      if (state.registrationEvent === event) state.previousOnRollback = null;
      if (state.replacedPending) {
        onSuppressed(state.replacedPending.event);
        state.replacedPending = null;
      }
    },
    rollback(event) {
      const entry = [...records].find(([, state]) => state.registrationEvent === event
        || state.startEvent === event || state.terminalEvent === event);
      const [key, state] = entry ?? [];
      if (!state) return;
      if (state.registrationEvent === event && !state.started) {
        const previous = state.previousOnRollback;
        remove(key);
        restorePrevious(previous);
      }
      else if (state.startEvent === event && !state.terminal) {
        if (state.kind === "run") {
          remove(key);
          return;
        }
        state.started = false;
        state.startEvent = null;
      } else if (state.terminalEvent === event && state.terminal) {
        if (state.kind === "run" && !state.startEvent) {
          remove(key);
          return;
        }
        state.terminal = false;
        state.durable = false;
        state.terminalEvent = null;
        if (state.replacedPending) {
          state.pendingTerminal = state.replacedPending.event;
          state.pendingRetryable = state.replacedPending.retryable;
          state.pendingAwaitingFinal = state.replacedPending.awaitingFinal;
          state.pendingConfirmed = state.replacedPending.confirmed;
          state.pendingPersistAttempts = state.replacedPending.persistAttempts;
          state.pendingDeadline = state.replacedPending.deadline;
          state.replacedPending = null;
          schedulePending(key, state);
        } else if (state.kind === "task") {
          state.pendingTerminal = event;
          state.pendingRetryable = false;
          state.pendingAwaitingFinal = false;
          state.pendingConfirmed = true;
          state.pendingPersistAttempts = 0;
          state.pendingDeadline = now() + persistRetryBaseMs;
          schedulePending(key, state);
        }
        if (state.kind === "task" && !currentBySession.has(state.sessionId)) {
          currentBySession.set(state.sessionId, key);
        }
      }
    },
    async flushPending() {
      for (const [key, state] of records) {
        if (state.pendingTerminal && !state.pendingAwaitingFinal && !state.terminal) {
          attemptPending(key, state);
        }
      }
    },
    activeRunIds,
    activeWork,
    cancelActiveRuns(makeTerminalEvent) {
      const terminals = [];
      for (const [key, state] of [...records]) {
        if (state.terminal) continue;
        if (state.pendingTerminal && !state.pendingAwaitingFinal) continue;
        if (state.pendingAwaitingFinal) clearPending(state, true);
        if (state.kind === "task" && !state.started) {
          state.terminal = true;
          state.durable = true;
          clearCurrent(key, state);
          continue;
        }
        const event = state.kind === "task"
          ? retarget(makeTerminalEvent(state.turnId, state.sessionId), state)
          : makeTerminalEvent(state.turnId, state.sessionId);
        state.terminal = true;
        state.durable = true;
        state.terminalEvent = event;
        clearCurrent(key, state);
        terminals.push(event);
      }
      return Object.freeze(terminals);
    },
    status: () => Object.freeze({
      activeRuns: activeWork().length,
      pendingTerminals: [...records.values()].filter((state) => state.pendingTerminal).length,
      awaitingFinals: [...records.values()].filter((state) => state.pendingAwaitingFinal).length,
      pendingTimers: [...records.values()].filter((state) => state.pendingTimer != null).length,
      trackedRuns: records.size,
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
    sessionId: event.sessionKey ?? event.sessionId,
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
      const terminalOrUnknown = data.phase !== "end"
        || data.success === false
        || data.aborted === true
        || data.timedOut === true
        || data.outcome === "timeout"
        || data.status === "cancelled"
        || data.status === "timed_out"
        || data.timeoutPhase != null
        || Object.hasOwn(data, "error");
      const yieldedContinuation = !terminalOrUnknown
        && data.yielded === true
        && data.livenessState === "paused"
        && data.stopReason === "end_turn";
      const toolCallsContinuation = !terminalOrUnknown
        && data.stopReason === "tool_calls";
      const continuationPending = yieldedContinuation || toolCallsContinuation;
      return {
        kind: "turn_end",
        outcome: cancelled ? "cancelled" : timedOut ? "timeout" : data.phase === "error" || data.success === false ? "failure" : "success",
        component: data.phase === "end" ? "agent_lifecycle_end" : "agent_lifecycle_error",
        status: data.phase === "error" && Number.isSafeInteger(data.endedAt)
          ? "terminal-candidate"
          : continuationPending ? "continuation-pending" : undefined,
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
  let failed = 0;
  let lastObservedAt = null;
  const observed = {};
  const diagnostics = {};
  const inboundRuns = new Map();
  const diagnose = (diagnostic) => {
    diagnostics[diagnostic.code] = (diagnostics[diagnostic.code] ?? 0) + 1;
    onDiagnostic(diagnostic);
  };
  const observe = (name, makeInput, immediate = false) => (event = {}, ctx = {}) => {
    observed[name] = (observed[name] ?? 0) + 1;
    lastObservedAt = new Date().toISOString();
    if (pending >= maxPending) {
      failed += 1;
      diagnose(localDiagnostic("hook-backpressure", "openclaw"));
      return;
    }
    let input;
    try { input = makeInput(event, ctx); } catch {
      failed += 1;
      diagnose(localDiagnostic("hook-read-failed", "openclaw"));
      return;
    }
    if (!input) { ignored += 1; return; }
    pending += 1;
    const dispatch = async () => {
      try {
        const result = normalizeRuntimeEvent("openclaw", input, envelopeFactory(input, event, ctx));
        if (result.event) {
          const accepted = await emit(result.event);
          const disposition = accepted?.disposition;
          if (disposition === "buffered") return;
          if (disposition === "failed") failed += 1;
          else if (accepted === false || disposition === "coalesced") ignored += 1;
          else emitted += 1;
        } else if (result.diagnostic) {
          ignored += 1;
          diagnose(result.diagnostic);
        }
      } catch {
        failed += 1;
        diagnose(localDiagnostic("hook-emit-failed", "openclaw"));
      }
      finally { pending -= 1; }
    };
    if (immediate) void dispatch();
    else queueMicrotask(dispatch);
  };
  const correlation = (event, ctx) => ({
    sessionId: ctx.sessionKey ?? ctx.sessionId ?? event.sessionKey ?? event.sessionId,
    turnId: ctx.runId ?? event.runId,
    toolCallId: ctx.toolCallId ?? event.toolCallId,
    messageId: ctx.messageId ?? event.messageId ?? event.inboundMessageId ?? event.outboundMessageId,
  });
  const inboundCorrelation = (event, ctx) => {
    const value = correlation(event, ctx);
    value.messageId ??= event.id;
    return value;
  };
  const rememberInboundRun = (value) => {
    if (!value.sessionId || !value.messageId) return value;
    // OpenClaw admits one normal dispatch per session and calls message_received
    // immediately before before_dispatch. Keep only the latest observation so a
    // fast-abort message, which has no before_dispatch, cannot shift the next task.
    inboundRuns.delete(value.sessionId);
    while (inboundRuns.size >= Math.max(1, maxPending)) inboundRuns.delete(inboundRuns.keys().next().value);
    inboundRuns.set(value.sessionId, value);
    return value;
  };
  const correlateDispatch = (event, ctx) => {
    const value = correlation(event, ctx);
    const matched = value.sessionId ? inboundRuns.get(value.sessionId) : null;
    if (!matched) return value;
    inboundRuns.delete(value.sessionId);
    if (value.messageId && value.messageId !== matched.messageId) return value;
    value.messageId ??= matched.messageId;
    value.turnId ??= matched.turnId;
    return value;
  };
  const hooks = {
    before_dispatch: observe("before_dispatch", (event, ctx) => ({
      kind: "message_received",
      component: "before_dispatch",
      correlation: correlateDispatch(event, ctx),
    }), true),
    reply_payload_sending: observe("reply_payload_sending", (event, ctx) => (
      (event.kind ?? ctx.kind) === "final"
        ? { kind: "turn_end", outcome: "success", component: "final_reply", correlation: correlation(event, ctx) }
        : null
    ), true),
    message_received: observe("message_received", (event, ctx) => ({
      kind: "message_received",
      component: "message_observation",
      correlation: rememberInboundRun(inboundCorrelation(event, ctx)),
    })),
    message_sent: observe("message_sent", (event, ctx) => ({
      kind: "delivery_end",
      outcome: event.success === false ? "failure" : "success",
      correlation: correlation(event, ctx),
    })),
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
    settle(outcome) {
      if (outcome === "emitted") emitted += 1;
      else if (outcome === "failed") failed += 1;
      else ignored += 1;
    },
    status: () => ({ observed: { ...observed }, emitted, ignored, failed, pending, diagnostics: { ...diagnostics }, lastObservedAt }),
  });
}
