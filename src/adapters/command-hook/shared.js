const SAFE_METADATA = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/;
const SECRET_MARKER = /(?:authorization|api[_-]?key|token|password|secret|credential)/i;

export function safeMetadata(...values) {
  return values.find((value) =>
    typeof value === "string" && SAFE_METADATA.test(value) && !SECRET_MARKER.test(value));
}

export function safeInteger(...values) {
  return values.find((value) => Number.isSafeInteger(value));
}

export function hookCorrelation(input = {}) {
  return {
    sessionId: safeMetadata(input.session_id, input.sessionId),
    turnId: safeMetadata(input.turn_id, input.prompt_id, input.turnId),
    toolCallId: safeMetadata(input.tool_use_id, input.toolCallId),
    parentEventId: safeMetadata(input.agent_id, input.parent_event_id),
  };
}

export function toolResultMetadata(response) {
  const value = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const exitCode = safeInteger(value.exit_code, value.exitCode, value.status_code, value.statusCode);
  const status = safeMetadata(value.status);
  const failed = value.success === false || value.is_error === true || value.isError === true ||
    (Number.isSafeInteger(exitCode) && exitCode !== 0) ||
    ["error", "failed", "failure", "timeout", "timed_out", "cancelled", "interrupted"].includes(status?.toLowerCase());
  const timedOut = ["timeout", "timed_out"].includes(status?.toLowerCase()) ||
    value.timed_out === true || value.timedOut === true;
  return { exitCode, status, failed, timedOut };
}

export function safeHookEvent(input = {}) {
  return safeMetadata(input.hook_event_name, input.hookEventName);
}
