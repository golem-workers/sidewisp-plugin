const DETAIL_KEYS = new Set(["code", "reason", "status", "component", "operation", "capability", "attempt", "count", "durationMs", "exitCode", "httpStatus", "recoverable", "expected"]);
const CORRELATION_KEYS = new Set(["sessionId", "turnId", "toolCallId", "messageId", "parentEventId"]);
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/;
const SECRET_VALUE = /(?:bearer\s+|authorization|api[_-]?key|token|password|secret|credential|[a-z]+:\/\/[^\s/:]+:[^\s/@]+@)/i;
const RUNTIME_KINDS = new Set(["openclaw", "hermes", "codex", "claude-code", "other"]);
const SOURCE_KINDS = new Set(["hook", "log", "state", "health", "collector"]);
const OUTCOMES = new Set(["info", "success", "failure", "degraded"]);
const EVENT_TYPES = new Set([
  "runtime.started", "runtime.stopped", "runtime.restarted", "runtime.crashed", "gateway.connected", "gateway.disconnected",
  "turn.started", "turn.completed", "turn.failed", "turn.timeout", "turn.cancelled", "tool.started", "tool.completed", "tool.failed", "tool.timeout", "tool.cancelled",
  "message.received", "message.delivered", "message.rejected", "message.failed", "provider.auth_failed", "provider.rate_limited", "provider.unavailable",
  "queue.stuck", "queue.recovered", "context.exhausted", "config.invalid", "plugin.failed", "health.snapshot", "collector.started", "collector.stopped", "collector.degraded",
]);

export class SanitizationError extends Error {
  constructor(code) {
    super(`telemetry sanitation failed: ${code}`);
    this.name = "SanitizationError";
    this.code = code;
  }
}

function safeString(value, key) {
  if (typeof value !== "string" || !SAFE_TEXT.test(value) || SECRET_VALUE.test(value)) throw new SanitizationError(`unsafe-${key}`);
  return value;
}

function pick(source, keys) {
  const output = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return output;
  for (const key of keys) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) continue;
    const value = source[key];
    if (typeof value === "string") output[key] = safeString(value, key);
    else if (typeof value === "boolean") output[key] = value;
    else if (Number.isSafeInteger(value)) output[key] = value;
    else throw new SanitizationError(`invalid-${key}`);
  }
  return output;
}

export function sanitizeTelemetryEvent(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SanitizationError("invalid-envelope");
    const runtime = pick(input.runtime, new Set(["kind", "name", "version", "instanceId"]));
    const source = pick(input.source, new Set(["kind", "adapterVersion", "cursor"]));
    if (!RUNTIME_KINDS.has(runtime.kind)) throw new SanitizationError("invalid-runtime-kind");
    if (!SOURCE_KINDS.has(source.kind)) throw new SanitizationError("invalid-source-kind");
    if (!EVENT_TYPES.has(input.type)) throw new SanitizationError("invalid-event-type");
    if (!OUTCOMES.has(input.outcome)) throw new SanitizationError("invalid-outcome");
    return {
      schema: "sidewisp.telemetry.v1",
      eventId: safeString(input.eventId, "event-id"),
      installationId: safeString(input.installationId, "installation-id"),
      sequence: Number.isSafeInteger(input.sequence) && input.sequence >= 0 ? input.sequence : (() => { throw new SanitizationError("invalid-sequence"); })(),
      occurredAt: safeString(input.occurredAt, "occurred-at"),
      observedAt: safeString(input.observedAt, "observed-at"),
      runtime,
      source,
      type: safeString(input.type, "type"),
      outcome: safeString(input.outcome, "outcome"),
      correlation: pick(input.correlation, CORRELATION_KEYS),
      details: pick(input.details, DETAIL_KEYS),
    };
  } catch (error) {
    if (error instanceof SanitizationError) throw error;
    throw new SanitizationError("unreadable-input");
  }
}

export function localSanitizationDiagnostic(error) {
  return Object.freeze({
    type: "collector.degraded",
    code: "telemetry-sanitization-failed",
    reason: error instanceof SanitizationError ? error.code : "unknown",
    localOnly: true,
  });
}
