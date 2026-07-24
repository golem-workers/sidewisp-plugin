import { sanitizeTelemetryEvent } from "./sanitize.js";

export const RUNTIME_MAPPING_VERSION = "sidewisp.runtime-map.v1";

export const RUNTIME_MAPPINGS = Object.freeze({
  openclaw: Object.freeze({
    runtime_start: "runtime-start", runtime_crash: "runtime-crash", gateway_up: "gateway-up", gateway_down: "gateway-down",
    turn_start: "turn-start", turn_end: "turn-end", tool_start: "tool-start", tool_end: "tool-end",
    message_received: "message-received", delivery_end: "delivery-end", provider_error: "provider-error",
    config_invalid: "config-invalid", queue_stuck: "queue-stuck", context_exhausted: "context-exhausted",
  }),
  hermes: Object.freeze({
    session_started: "runtime-start", session_crashed: "runtime-crash", gateway_connected: "gateway-up", gateway_disconnected: "gateway-down",
    llm_call_start: "turn-start", llm_call_end: "turn-end", tool_call_start: "tool-start", tool_call_end: "tool-end",
    message_received: "message-received", message_delivery_end: "delivery-end", llm_provider_error: "provider-error",
    configuration_error: "config-invalid", task_queue_stalled: "queue-stuck", context_limit_reached: "context-exhausted",
  }),
  codex: Object.freeze({
    runtime_start: "runtime-start", runtime_stop: "runtime-stop",
    turn_start: "turn-start", turn_end: "turn-end",
    tool_start: "tool-start", tool_end: "tool-end",
    provider_error: "provider-error", context_exhausted: "context-exhausted",
  }),
  "claude-code": Object.freeze({
    runtime_start: "runtime-start", runtime_stop: "runtime-stop",
    turn_start: "turn-start", turn_end: "turn-end",
    tool_start: "tool-start", tool_end: "tool-end",
    provider_error: "provider-error", context_exhausted: "context-exhausted",
  }),
});

const FIXED = Object.freeze({
  "runtime-start": ["runtime.started", "success"], "runtime-stop": ["runtime.stopped", "success"],
  "runtime-crash": ["runtime.crashed", "failure"],
  "gateway-up": ["gateway.connected", "success"], "gateway-down": ["gateway.disconnected", "failure"],
  "config-invalid": ["config.invalid", "failure"], "queue-stuck": ["queue.stuck", "failure"],
  "context-exhausted": ["context.exhausted", "failure"],
  "turn-start": ["turn.started", "info"], "tool-start": ["tool.started", "info"],
  "message-received": ["message.received", "info"],
});

function variableFact(kind, input) {
  if (kind === "turn-end") {
    if (input.outcome === "cancelled") return ["turn.cancelled", "info", { reason: "user-cancelled", expected: true }];
    if (input.outcome === "timeout") return ["turn.timeout", input.expected ? "info" : "failure", { reason: input.expected ? "expected-timeout" : "timeout", expected: Boolean(input.expected) }];
    return input.outcome === "success" ? ["turn.completed", "success"] : ["turn.failed", "failure"];
  }
  if (kind === "tool-end") {
    if (input.outcome === "cancelled") return ["tool.cancelled", "info", { reason: "user-cancelled", expected: true }];
    if (input.outcome === "timeout") return ["tool.timeout", input.expected ? "info" : "failure", { reason: input.expected ? "expected-timeout" : "timeout", expected: Boolean(input.expected) }];
    return input.outcome === "success" ? ["tool.completed", "success"] : ["tool.failed", "failure"];
  }
  if (kind === "delivery-end") {
    if (input.outcome === "policy-rejected") return ["message.rejected", "info", { reason: "policy-rejection", expected: true }];
    return input.outcome === "success" ? ["message.delivered", "success"] : ["message.failed", "failure"];
  }
  if (kind === "provider-error") {
    if ([401, 403].includes(input.httpStatus)) return ["provider.auth_failed", "failure", { httpStatus: input.httpStatus }];
    if (input.httpStatus === 429) return ["provider.rate_limited", "degraded", { httpStatus: 429, recoverable: true }];
    return ["provider.unavailable", "failure", { recoverable: true }];
  }
  return FIXED[kind];
}

export function normalizeRuntimeEvent(runtimeKind, input, envelope) {
  try {
    const semantic = RUNTIME_MAPPINGS[runtimeKind]?.[input?.kind];
    if (!semantic) return { event: null, diagnostic: localDiagnostic("unsupported-runtime-event", runtimeKind) };
    const fact = variableFact(semantic, input) ?? FIXED[semantic];
    if (!fact) return { event: null, diagnostic: localDiagnostic("unmapped-runtime-event", runtimeKind) };
    const [type, outcome, factDetails = {}] = fact;
    const event = sanitizeTelemetryEvent({
      ...envelope,
      runtime: { ...envelope.runtime, kind: runtimeKind },
      source: { ...envelope.source, adapterVersion: envelope.source.adapterVersion },
      type, outcome,
      correlation: input.correlation ?? {},
      details: {
        ...factDetails,
        code: input.code,
        component: input.component,
        operation: input.operation,
        status: input.status,
        exitCode: input.exitCode,
        durationMs: input.durationMs,
        recoverable: input.recoverable,
        expected: input.expected ?? factDetails.expected,
      },
    });
    return { event, diagnostic: null };
  } catch {
    return { event: null, diagnostic: localDiagnostic("normalization-failed", runtimeKind) };
  }
}

export function localDiagnostic(code, runtimeKind, details = {}) {
  return Object.freeze({
    schema: "sidewisp.collector-diagnostic.v1", mappingVersion: RUNTIME_MAPPING_VERSION,
    code, runtimeKind, localOnly: true,
    count: Number.isSafeInteger(details.count) ? details.count : 1,
  });
}
