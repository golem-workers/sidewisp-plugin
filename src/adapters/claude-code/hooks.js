import {
  hookCorrelation,
  safeHookEvent,
  safeInteger,
  safeMetadata,
} from "../command-hook/shared.js";

export const CLAUDE_CODE_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
]);

const PROVIDER_STATUS = Object.freeze({
  authentication_failed: 401,
  oauth_org_not_allowed: 401,
  billing_error: 402,
  rate_limit: 429,
  overloaded: 503,
  server_error: 503,
});

function stopFailureInputs(payload, correlation) {
  const code = safeMetadata(payload.error) ?? "unknown";
  const output = [{ kind: "turn_end", outcome: "failure", code, correlation }];
  if (code === "max_output_tokens") {
    output.push({ kind: "context_exhausted", code, correlation });
  } else {
    output.push({ kind: "provider_error", code, httpStatus: PROVIDER_STATUS[code], correlation });
  }
  return output;
}

export function claudeCodeHookInputs(payload = {}) {
  const event = safeHookEvent(payload);
  const correlation = hookCorrelation(payload);
  if (event === "SessionStart") return [{ kind: "runtime_start", correlation }];
  if (event === "SessionEnd") return [{ kind: "runtime_stop", correlation }];
  if (event === "UserPromptSubmit") return [{ kind: "turn_start", correlation }];
  if (event === "Stop") return [{ kind: "turn_end", outcome: "success", correlation }];
  if (event === "StopFailure") return stopFailureInputs(payload, correlation);
  if (event === "PreToolUse") {
    return [{
      kind: "tool_start",
      operation: safeMetadata(payload.tool_name),
      correlation,
    }];
  }
  if (event === "PostToolUse") {
    return [{
      kind: "tool_end",
      outcome: "success",
      operation: safeMetadata(payload.tool_name),
      durationMs: safeInteger(payload.duration_ms, payload.durationMs),
      correlation,
    }];
  }
  if (event === "PostToolUseFailure") {
    return [{
      kind: "tool_end",
      outcome: payload.is_interrupt === true ? "cancelled" : "failure",
      operation: safeMetadata(payload.tool_name),
      durationMs: safeInteger(payload.duration_ms, payload.durationMs),
      code: payload.is_interrupt === true ? "KILLED" : "UNKNOWN",
      recoverable: payload.is_interrupt !== true,
      correlation,
    }];
  }
  if (event === "PermissionDenied") {
    return [{
      kind: "tool_end",
      outcome: "cancelled",
      operation: safeMetadata(payload.tool_name),
      code: "PERMISSION_DENIED",
      expected: true,
      correlation,
    }];
  }
  return [];
}
