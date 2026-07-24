import assert from "node:assert/strict";
import test from "node:test";

import { claudeCodeHookInputs, CLAUDE_CODE_HOOK_EVENTS } from "../src/adapters/claude-code/hooks.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";

const envelope = {
  eventId: "sw_evt_claudefixture0000000000001",
  installationId: "sw_ins_claudefixture",
  sequence: 1,
  occurredAt: "2026-07-24T00:00:00.000Z",
  observedAt: "2026-07-24T00:00:00.000Z",
  runtime: { version: "2.1.218" },
  source: { kind: "hook", adapterVersion: "0.2.0" },
};

test("Claude Code hook contract covers lifecycle, turns, tools and provider failures", () => {
  assert.deepEqual(CLAUDE_CODE_HOOK_EVENTS, [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "PermissionDenied", "Stop", "StopFailure",
  ]);
  const lifecycle = [
    [{ hook_event_name: "SessionStart", session_id: "session-1" }, "runtime.started"],
    [{ hook_event_name: "SessionEnd", session_id: "session-1", reason: "other" }, "runtime.stopped"],
    [{ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt_id: "prompt-1" }, "turn.started"],
    [{ hook_event_name: "Stop", session_id: "session-1", prompt_id: "prompt-1" }, "turn.completed"],
  ];
  for (const [payload, expected] of lifecycle) {
    const input = claudeCodeHookInputs(payload)[0];
    assert.equal(normalizeRuntimeEvent("claude-code", input, envelope).event.type, expected);
  }
});

test("Claude Code failures retain safe classes and discard error content", () => {
  const toolInput = claudeCodeHookInputs({
    hook_event_name: "PostToolUseFailure",
    session_id: "session-1",
    prompt_id: "prompt-1",
    tool_use_id: "toolu_1",
    tool_name: "Bash",
    duration_ms: 4187,
    error: "private command output",
    tool_input: { command: "private command" },
  })[0];
  const toolEvent = normalizeRuntimeEvent("claude-code", toolInput, envelope).event;
  assert.deepEqual([toolEvent.type, toolEvent.outcome, toolEvent.details.code, toolEvent.details.durationMs], [
    "tool.failed", "failure", "UNKNOWN", 4187,
  ]);

  const failureInputs = claudeCodeHookInputs({
    hook_event_name: "StopFailure",
    session_id: "session-1",
    prompt_id: "prompt-1",
    error: "rate_limit",
    error_details: "private provider response",
    last_assistant_message: "private completion",
  });
  const events = failureInputs.map((input, index) => normalizeRuntimeEvent("claude-code", input, {
    ...envelope,
    eventId: `sw_evt_claudefixture000000000000${index + 2}`,
    sequence: index + 2,
  }).event);
  assert.deepEqual(events.map(({ type }) => type), ["turn.failed", "provider.rate_limited"]);
  const serialized = JSON.stringify({ toolInput, toolEvent, failureInputs, events });
  for (const forbidden of ["private command output", "private command", "private provider response", "private completion"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("Claude Code permission denial is expected cancellation", () => {
  const input = claudeCodeHookInputs({
    hook_event_name: "PermissionDenied",
    session_id: "session-1",
    prompt_id: "prompt-1",
    tool_use_id: "toolu_1",
    tool_name: "Write",
    reason: "private policy text",
  })[0];
  const event = normalizeRuntimeEvent("claude-code", input, envelope).event;
  assert.deepEqual([event.type, event.outcome, event.details.expected], ["tool.cancelled", "info", true]);
  assert.equal(JSON.stringify(event).includes("private policy text"), false);
});
