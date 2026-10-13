import { createHash } from "node:crypto";
import { userWaitPreview } from "../../core/preview-sources.js";

// Read-only adapter for the pinned 2026.9.8 blocking ask_user registry.
// Native tool.start reserves a prompt; only answerable means delivery succeeded
// and execution is actually waiting. Registration/prompting are not user waits.
export function createOpenClawQuestionObserver({ emit, now = Date.now, pollMs = 10,
  maxPending = 1000, readRegistry = () => globalThis[Symbol.for("openclaw.askUserQuestions")],
  readPendingRegistry = () => globalThis[Symbol.for("openclaw.pendingAgentQuestions")] } = {}) {
  const calls = new Map();
  // Bounded tombstones prevent replayed starts from recreating completed waits.
  const retired = new Set();
  const conflictedRuns = new Set();
  const remember = (set, id) => { set.add(id); if (set.size > maxPending) set.delete(set.values().next().value); };
  const retire = id => { calls.delete(id); remember(retired, id); if (!calls.size) stopTimer(); };
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
    ...(kind === "tool_start" && call.preview ? { messagePreview: call.preview } : {}),
    correlation: { sessionId: call.sessionKey, turnId: call.runId, toolCallId: call.questionId } });
  function finishContinuation(call) {
    if (!call.waiting || !call.settled || !call.resolved || !(call.continuationSeq > call.resultSeq)) return;
    enqueue(input(call, "tool_end"));
    retire(`${call.runId}\0${call.toolCallId}`);
  }
  function captureResolution(call, pendingRegistry) {
    const claim = pendingRegistry instanceof Map ? pendingRegistry.get(call.sessionKey) : undefined;
    if (call.answerPromise || !call.waiting || claim?.kind !== "gateway"
        || claim.questionId !== call.questionId || claim.sessionKey !== call.sessionKey
        || !(claim.answer instanceof Promise)) return;
    call.answerPromise = claim.answer;
    claim.answer.then(result => {
      if (calls.get(`${call.runId}\0${call.toolCallId}`) !== call) return;
      // Native question RPC status only; no answer values or protocol response text.
      if (["answered", "expired", "cancelled"].includes(result?.status)) {
        call.resolved = true;
        finishContinuation(call);
      }
    }, () => {});
  }
  function scan() {
    if (!calls.size) return;
    const registry = readRegistry();
    if (!(registry instanceof Map)) return;
    const pendingRegistry = readPendingRegistry();
    for (const call of calls.values()) {
      if (conflictedRuns.has(call.runId)) continue;
      const state = registry.get(call.questionId);
      // Exact native question identity owns both the session and the answer promise.
      // Attach read-only before native cleanup; never read answer values or claim input.
      if (!state || (state.questionId !== undefined && state.questionId !== call.questionId)
          || !bind(call, session(state.sessionKey))) continue;
      captureResolution(call, pendingRegistry);
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
      call.preview = userWaitPreview({ args: { get questions() { return state.questions; } } }, "request_user_input", "tool.started");
      enqueue(input(call, "tool_start"));
      captureResolution(call, pendingRegistry);
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
    const continuation = event.stream === "assistant"
      || (event.stream === "item" && data.kind === "preamble" && data.phase === "end")
      || (event.stream === "tool" && data.phase === "start");
    for (const [id, call] of calls) {
      if (call.runId !== event.runId) continue;
      if (!call.sessionKey) { if (terminal) retire(id); continue; }
      // A result alone is not continuation: an abort can deliver a tool receipt.
      const newExecution = event.seq > call.resultSeq
        && !(event.stream === "tool" && data.toolCallId === call.toolCallId);
      if (call.settled && continuation && newExecution) {
        call.continuationSeq = event.seq;
        finishContinuation(call);
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
          // Legacy structured receipts remain supported. Codex needs the exact
          // native RPC promise captured above, never its protocol response text.
          const status = data.result?.details?.status;
          if (data.isError === true || data.result?.success === false) retire(id);
          else {
            call.settled = true; call.resultSeq = Math.min(call.resultSeq, event.seq);
            if (["answered", "no_answer"].includes(status)) call.resolved = true;
            // The exact native answer promise may settle after this Codex receipt.
            // Missing details, deleted registry entries and text confer no resolution.
          }
        }
      }
    }
    if (!calls.size) stopTimer();
  }
  return Object.freeze({ observe, scan, drain: () => pending, dispose() { stopTimer(); calls.clear(); retired.clear(); conflictedRuns.clear(); } });
}
