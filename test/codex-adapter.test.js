import assert from "node:assert/strict";
import test from "node:test";

import { codexHookInputs, CODEX_HOOK_EVENTS } from "../src/adapters/codex/hooks.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";

const envelope = {
  eventId: "sw_evt_codexfixture00000000000001",
  installationId: "sw_ins_codexfixture",
  sequence: 1,
  occurredAt: "2026-07-24T00:00:00.000Z",
  observedAt: "2026-07-24T00:00:00.000Z",
  runtime: { version: "0.145.0" },
  source: { kind: "hook", adapterVersion: "0.2.0" },
};

test("Codex hook contract covers lifecycle, turns and tools", () => {
  assert.deepEqual(CODEX_HOOK_EVENTS, [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop",
  ]);
  const cases = [
    [{ hook_event_name: "SessionStart", session_id: "thr_1" }, "runtime.started"],
    [{ hook_event_name: "SessionEnd", session_id: "thr_1" }, "runtime.stopped"],
    [{ hook_event_name: "UserPromptSubmit", session_id: "thr_1", turn_id: "turn_1" }, "turn.started"],
    [{ hook_event_name: "Stop", session_id: "thr_1", turn_id: "turn_1" }, "turn.completed"],
    [{ hook_event_name: "PreToolUse", session_id: "thr_1", turn_id: "turn_1", tool_use_id: "call_1", tool_name: "Bash" }, "tool.started"],
  ];
  for (const [payload, expected] of cases) {
    const input = codexHookInputs(payload)[0];
    assert.equal(normalizeRuntimeEvent("codex", input, envelope).event.type, expected);
  }
});

test("Codex PostToolUse reads bounded result metadata only", () => {
  const input = codexHookInputs({
    hook_event_name: "PostToolUse",
    session_id: "thr_1",
    turn_id: "turn_1",
    tool_use_id: "call_1",
    tool_name: "Bash",
    tool_input: { command: "private command", token: "forbidden" },
    tool_response: { exit_code: 7, stdout: "private output", stderr: "private error" },
    prompt: "private prompt",
    last_assistant_message: "private completion",
  })[0];
  const event = normalizeRuntimeEvent("codex", input, envelope).event;
  assert.equal(event.type, "tool.failed");
  assert.equal(event.details.exitCode, 7);
  assert.equal(event.details.operation, "Bash");
  const serialized = JSON.stringify({ input, event });
  for (const forbidden of ["private command", "private output", "private error", "private prompt", "private completion", "forbidden"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("Codex ignores unknown hooks without inspecting content", () => {
  assert.deepEqual(codexHookInputs({ hook_event_name: "FutureEvent", prompt: "private" }), []);
});
