import { localDiagnostic, normalizeRuntimeEvent } from "../../core/normalize.js";

export const OPENCLAW_HOOK_SOURCES = Object.freeze({
  before_agent_run: "src/plugins/hook-types.ts:1120",
  agent_end: "src/plugins/hook-types.ts:389",
  before_tool_call: "src/plugins/hook-types.ts:650",
  after_tool_call: "src/plugins/hook-types.ts:682",
  message_received: "src/plugins/hook-message.types.ts:70",
  message_sent: "src/plugins/hook-message.types.ts:111",
  gateway_start: "src/plugins/hook-types.ts:898",
  gateway_stop: "src/plugins/hook-types.ts:902",
});

export function registerOpenClawHooks(api, { emit, envelopeFactory, onDiagnostic = () => {}, maxPending = 1000 }) {
  let pending = 0;
  let emitted = 0;
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
          await emit(result.event);
          emitted += 1;
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
    before_agent_run: observe("before_agent_run", (event, ctx) => ({ kind: "turn_start", correlation: correlation(event, ctx) })),
    agent_end: observe("agent_end", (event, ctx) => ({ kind: "turn_end", outcome: event.success ? "success" : "failure", durationMs: event.durationMs, correlation: correlation(event, ctx) })),
    before_tool_call: observe("before_tool_call", (event, ctx) => ({ kind: "tool_start", correlation: correlation(event, ctx) })),
    after_tool_call: observe("after_tool_call", (event, ctx) => ({ kind: "tool_end", outcome: event.error ? "failure" : "success", durationMs: event.durationMs, correlation: correlation(event, ctx) })),
    message_received: observe("message_received", (event, ctx) => ({ kind: "message_received", correlation: correlation(event, ctx) })),
    message_sent: observe("message_sent", (event, ctx) => ({ kind: "delivery_end", outcome: event.success ? "success" : "failure", correlation: correlation(event, ctx) })),
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
    status: () => ({ observed: { ...observed }, emitted, pending, diagnostics: { ...diagnostics }, lastObservedAt }),
  });
}
