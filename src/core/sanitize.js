const DETAIL_KEYS = new Set(["code", "reason", "status", "component", "operation", "capability", "attempt", "count", "durationMs", "exitCode", "httpStatus", "recoverable", "expected"]);
const CORRELATION_KEYS = new Set(["sessionId", "turnId", "toolCallId", "messageId", "parentEventId"]);
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/;
const SECRET_VALUE = /(?:bearer\s+|authorization|api[_-]?key|token|password|secret|credential|[a-z]+:\/\/[^\s/:]+:[^\s/@]+@)/i;

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
    return {
      schema: "sidewisp.telemetry.v1",
      eventId: safeString(input.eventId, "event-id"),
      installationId: safeString(input.installationId, "installation-id"),
      sequence: Number.isSafeInteger(input.sequence) && input.sequence >= 0 ? input.sequence : (() => { throw new SanitizationError("invalid-sequence"); })(),
      occurredAt: safeString(input.occurredAt, "occurred-at"),
      observedAt: safeString(input.observedAt, "observed-at"),
      runtime: pick(input.runtime, new Set(["kind", "name", "version", "instanceId"])),
      source: pick(input.source, new Set(["kind", "adapterVersion", "cursor"])),
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
