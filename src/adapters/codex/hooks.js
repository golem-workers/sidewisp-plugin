import {
  hookCorrelation,
  safeHookEvent,
  safeMetadata,
  toolResultMetadata,
} from "../command-hook/shared.js";

export const CODEX_HOOK_EVENTS = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
]);

export function codexHookInputs(payload = {}) {
  const event = safeHookEvent(payload);
  const correlation = hookCorrelation(payload);
  if (event === "SessionStart") return [{ kind: "runtime_start", correlation }];
  if (event === "SessionEnd") return [{ kind: "runtime_stop", correlation }];
  if (event === "UserPromptSubmit") return [{ kind: "turn_start", correlation }];
  if (event === "Stop") return [{ kind: "turn_end", outcome: "success", correlation }];
  if (event === "PreToolUse") {
    return [{
      kind: "tool_start",
      operation: safeMetadata(payload.tool_name),
      correlation,
    }];
  }
  if (event === "PostToolUse") {
    const result = toolResultMetadata(payload.tool_response);
    return [{
      kind: "tool_end",
      outcome: result.timedOut ? "timeout" : result.failed ? "failure" : "success",
      operation: safeMetadata(payload.tool_name),
      exitCode: result.exitCode,
      status: result.status,
      correlation,
    }];
  }
  return [];
}
