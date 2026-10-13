import { createHash } from "node:crypto";

// Read-only adapter for the pinned 2026.9.8 blocking ask_user registry.
// Native tool.start reserves a prompt; only answerable means delivery succeeded
// and execution is actually waiting. Registration/prompting are not user waits.
export function createOpenClawQuestionObserver({ emit, now = Date.now, pollMs = 10,
  maxPending = 1000, readRegistry = () => globalThis[Symbol.for("openclaw.askUserQuestions")] } = {}) {
  const calls = new Map();
  // Bounded tombstones prevent replayed starts from recreating completed waits.
  const retired = new Set();
  const conflictedRuns = new Set();
  const remember = (set, id) => { set.add(id); if (set.size > maxPending) set.delete(set.values().next().value); };
  const retire = id => { calls.delete(id); remember(retired, id); };
  const conflict = runId => {
    remember(conflictedRuns, runId);
    for (const [id, call] of calls) if (call.runId === runId) retire(id);
  };
  const session = value => typeof value === "string" && value.trim() ? value : undefined;
  function bind(call, sessionKey) {
    if (!sessionKey) return false;
    if (call.sessionKey && call.sessionKey !== sessionKey
        || [...calls.values()].some(other => other.runId === call.runId
          && other.sessionKey && other.sessionKey !== sessionKey)) {
      conflict(call.runId);
      return false;
    }
    call.sessionKey = sessionKey;
    return true;
  }
  let timer;
  let pending = Promise.resolve();
  const enqueue = value => { pending = pending.then(() => emit(value)).catch(() => {}); };
  const key = e => `${e.runId}\0${e.data?.toolCallId}`;
  const stopTimer = () => { if (timer) clearInterval(timer); timer = undefined; };
  const input = (call, kind) => ({ kind, operation: "request_user_input",
    component: "ask_user_wait", outcome: kind === "tool_end" ? "success" : undefined,
    correlation: { sessionId: call.sessionKey, turnId: call.runId, toolCallId: call.questionId } });
  function scan() {
    if (!calls.size) return;
    const registry = readRegistry();
    if (!(registry instanceof Map)) return;
    for (const call of calls.values()) {
      if (conflictedRuns.has(call.runId)) continue;
      const state = registry.get(call.questionId);
      // Native question ID hashes runId + toolCallId; never scan for a current
      // session or use question text. The exact registry entry owns the session.
      if (!state || (state.questionId !== undefined && state.questionId !== call.questionId)
          || !bind(call, session(state.sessionKey))) continue;
    }
    // Validate all available identities before emitting any wait in this scan.
    for (const call of calls.values()) {
      if (conflictedRuns.has(call.runId) || !call.sessionKey || call.waiting || call.settled) continue;
      const state = registry.get(call.questionId);
      if (!state || state.sessionKey !== call.sessionKey
          || (state.questionId !== undefined && state.questionId !== call.questionId)) continue;
      if (state.phase?.kind !== "answerable"
          || !Number.isFinite(state.expiresAtMs) || state.expiresAtMs <= now()) continue;
      call.waiting = true;
      enqueue(input(call, "tool_start"));
    }
  }
  function observe(event) {
    const data = event?.data ?? {};
    if (!Number.isSafeInteger(event?.seq) || event.seq < 1) return;
    if (typeof event?.runId !== "string" || !event.runId.trim() || conflictedRuns.has(event.runId)) return;
    const sessionKey = session(event.sessionKey);
    // A missing key is supported; a supplied malformed/conflicting key is not.
    if (event.sessionKey !== undefined && !sessionKey) { conflict(event.runId); return; }
    for (const call of calls.values()) {
      if (call.runId === event.runId && sessionKey && !bind(call, sessionKey)) return;
    }
    scan();
    if (conflictedRuns.has(event.runId)) return;
    const terminal = event.stream === "lifecycle" && ["end", "error"].includes(data.phase);
    const successEnd = terminal && data.phase === "end" && data.success !== false
      && data.aborted !== true && data.timedOut !== true && data.timeoutPhase == null
      && !["error", "aborted", "timeout", "restart"].includes(data.stopReason)
      && !["blocked", "abandoned"].includes(data.livenessState);
    const continuation = successEnd || event.stream === "assistant"
      || (event.stream === "item" && data.kind === "preamble" && data.phase === "end")
      || (event.stream === "tool" && data.phase === "start");
    for (const [id, call] of calls) {
      if (call.runId !== event.runId) continue;
      if (!call.sessionKey) { if (terminal) retire(id); continue; }
      // A result alone is not continuation: an abort can deliver a tool receipt.
      const newExecution = event.seq > call.resultSeq
        && !(event.stream === "tool" && data.toolCallId === call.toolCallId);
      if (call.settled && continuation && newExecution) {
        if (call.waiting) enqueue(input(call, "tool_end"));
        retire(id);
      } else if (terminal) retire(id);
    }
    if (event.stream === "tool" && data.name === "ask_user") {
      const id = key(event);
      if (data.phase === "start" && typeof data.toolCallId === "string" && !calls.has(id) && !retired.has(id) && calls.size < maxPending) {
        const questionId = "ask_" + createHash("sha256").update(`${event.runId}\0${data.toolCallId}`).digest("hex").slice(0, 32);
        calls.set(id, { questionId, sessionKey, runId: event.runId,
          toolCallId: data.toolCallId, waiting: false, settled: false, resultSeq: Infinity });
        scan();
        timer ??= setInterval(scan, pollMs);
        timer.unref?.();
      } else if (data.phase === "result") {
        const call = calls.get(id);
        if (call) {
          // Native receipt owns answered/no_answer. Neither question text nor a
          // generic isError alone is evidence of an answered/resolved question.
          const status = data.result?.details?.status;
          if (data.isError !== true && ["answered", "no_answer"].includes(status)) { call.settled = true; call.resultSeq = event.seq; }
          else retire(id);
        }
      }
    }
    if (!calls.size) stopTimer();
  }
  return Object.freeze({ observe, scan, drain: () => pending, dispose() { stopTimer(); calls.clear(); retired.clear(); conflictedRuns.clear(); } });
}
