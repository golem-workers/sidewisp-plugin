import assert from "node:assert/strict";
import test from "node:test";
import { userWaitPreview } from "../src/core/preview-sources.js";
import { openClawAgentEventInput } from "../src/adapters/openclaw/hooks.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";
const envelope = { eventId: "evt_fixture", installationId: "ins_fixture", sequence: 1,
  occurredAt: "2026-10-10T00:00:00.000Z", observedAt: "2026-10-10T00:00:00.000Z",
  runtime: { version: "2026.9.8" }, source: { kind: "hook", adapterVersion: "0.2.63" } };
test("questions and structured answers only; never arbitrary tool payload or logs", () => {
  const forbidden = { get content() { throw Error("private"); }, get command() { throw Error("private"); }, get output() { throw Error("private"); } };
  assert.equal(userWaitPreview(forbidden, "exec", "tool.started"), undefined);
  assert.equal(userWaitPreview({ args: { questions: [{ question: "Какой вариант выбрать?", options: [{ label: "token=hidden" }] }] } }, "request_user_input", "tool.started"), "Какой вариант выбрать?");
  assert.equal(userWaitPreview({ result: { answers: { choice: { answers: ["Вариант А"] } }, get content() { throw Error("private"); } } }, "request_user_input", "tool.completed"), "Вариант А");
  assert.equal(userWaitPreview({ result: { text: "PRIVATE_TOOL_OUTPUT" } }, "request_user_input", "tool.completed"), undefined);
  assert.equal(userWaitPreview({ args: { questions: [{ question: "token=hidden" }] } }, "request_user_input", "tool.started"), undefined);
  assert.equal(userWaitPreview({ result: { answers: { choice: { answers: ["password=hidden"] } } } }, "request_user_input", "tool.completed"), undefined);
  assert.equal(userWaitPreview({ title: "Подтвердите продолжение", get command() { throw Error("private"); } }, "user_approval", "tool.started"), "Подтвердите продолжение");
  assert.equal(userWaitPreview({ status: "approved", get message() { throw Error("private"); } }, "user_approval", "tool.completed"), "Подтверждение пользователя: одобрено.");
  assert.equal(userWaitPreview({ status: "unknown" }, "user_approval", "tool.completed"), undefined);
});
test("native wait events and confirmed failures carry only matching safe excerpts/reasons", () => {
  const base = { sessionKey: "agent:main:telegram:group:fixture", runId: "run_fixture" };
  const cases = [
    [{ ...base, stream: "tool", data: { phase: "start", name: "request_user_input", toolCallId: "call", args: { questions: [{ question: "Продолжить проверку?" }] } } }, "tool.started", "Продолжить проверку?"],
    [{ ...base, stream: "tool", data: { phase: "result", name: "request_user_input", toolCallId: "call", result: { answers: { choice: { answers: ["Продолжить"] } } } } }, "tool.completed", "Продолжить"],
    [{ ...base, stream: "lifecycle", data: { phase: "end", aborted: true, get error() { throw Error("private"); } } }, "turn.cancelled", "Причина события: выполнение остановлено."],
    [{ ...base, stream: "lifecycle", data: { phase: "end", timedOut: true } }, "turn.timeout", "Причина события: превышено время выполнения."],
    [{ ...base, stream: "lifecycle", data: { phase: "error", get error() { throw Error("private"); } } }, "turn.failed", "Причина события: ошибка выполнения."],
  ];
  for (const [source, type, expected] of cases) {
    const input = openClawAgentEventInput(source);
    const result = normalizeRuntimeEvent("openclaw", input, envelope);
    assert.equal(result.event?.type, type); assert.equal(result.event?.messagePreview, expected);
  }
  const started = normalizeRuntimeEvent("openclaw", { kind: "turn_start", messagePreview: "Не показывать" }, envelope);
  assert.equal(Object.hasOwn(started.event, "messagePreview"), false);
  const unknown = normalizeRuntimeEvent("openclaw", { kind: "turn_end" }, envelope);
  assert.equal(Object.hasOwn(unknown.event, "messagePreview"), false);
});
