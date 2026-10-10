import assert from "node:assert/strict";
import test from "node:test";
import { readMessagePreview, sanitizeMessagePreview } from "../src/core/message-preview.js";

test("message preview is optional, single-line, bounded and Unicode-safe", () => {
  for (const value of [undefined, null, "", " \n\t ", 42, [], {}, "x".repeat(16385)]) {
    assert.equal(sanitizeMessagePreview(value, "turn.completed"), undefined);
  }
  assert.equal(sanitizeMessagePreview("  Проверка\r\nготова\t к\u2028просмотру  ", "turn.completed"), "Проверка готова к просмотру");
  for (const value of ["Готово ".repeat(40), "🙂 ".repeat(80), "а".repeat(158) + "🙂" + " готово"]) {
    const result = sanitizeMessagePreview(value, "turn.progress");
    assert.ok(result.length <= 160);
    assert.ok(result.endsWith("…"));
    assert.equal(/\p{Cs}/u.test(result), false);
    assert.equal(sanitizeMessagePreview(result, "turn.progress"), result);
  }
  assert.equal(sanitizeMessagePreview("а".repeat(160), "message.delivered").length, 160);
  assert.equal(sanitizeMessagePreview("Готово", "message.received"), undefined);
  assert.equal(sanitizeMessagePreview("Готово", "tool.completed"), undefined);
  assert.equal(readMessagePreview(() => { throw new Error("private read"); }, "turn.completed"), undefined);
});

test("preview fails closed on credentials, credential values, personal/contact data and code", () => {
  for (const value of [
    "Bearer abcdef", "API_KEY=abc", "authorization: Basic abc", "пароль: abc", "секрет: abc",
    "Токен: abc", "person@example.test", "+7 (999) 123-45-67",
    "4111 1111 1111 1111", "https://example.test/?key=abc", "https://name:pass@example.test",
    "```hidden code```",
    "sk-123456", "ghp_abc", "xoxb_abc", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    "api\u200b_key=abc", "ＡＰＩ＿ＫＥＹ=abc", "bad\u0000text", "а\ud800",
    "Готово ".repeat(40) + "password=hidden-after-cutoff",
    "Готово ".repeat(40) + "person@example.test",
  ]) assert.equal(sanitizeMessagePreview(value, "turn.completed"), undefined, value);
});

import { registerOpenClawHooks } from "../src/adapters/openclaw/hooks.js";
import { sanitizeTelemetryEvent } from "../src/core/sanitize.js";
const envelope = () => ({
  eventId: "sw_evt_previewtest00000001", installationId: "sw_ins_preview001", sequence: 1,
  occurredAt: "2026-10-09T00:00:00.000Z", observedAt: "2026-10-09T00:00:00.000Z",
  runtime: { version: "2026.9.1" }, source: { kind: "hook", adapterVersion: "0.2.56" },
});
test("only confirmed outgoing boundaries produce safe previews and never modify payload", async () => {
  const hooks = new Map(), events = [];
  registerOpenClawHooks({ on: (name, handler) => hooks.set(name, handler) }, {
    emit: event => events.push(event), envelopeFactory: envelope,
  });
  const ctx = { sessionKey: "agent:main:telegram:group:fixture", runId: "run" };
  let observer;
  hooks.get("reply_dispatch")({}, { ...ctx, dispatcher: { appendBeforeDeliver: cb => { observer = cb; } } });
  const payload = Object.freeze({ text: "  Работа\nготова  ", get attachments() { throw Error("not text"); } });
  assert.equal(observer(payload, { kind: "tool" }), payload);
  assert.equal(events.length, 0);
  assert.equal(observer(payload, { kind: "final" }), payload);
  assert.equal(events[0].type, "turn.completed");
  assert.equal(events[0].messagePreview, "Работа готова");
  const throwing = Object.freeze({ get text() { throw Error("unreadable"); } });
  assert.equal(observer(throwing, { kind: "final" }), throwing);
  assert.equal(events[1].type, "turn.completed");
  assert.equal("messagePreview" in events[1], false);
  const source = { toolName: "message", params: { action: "send", final: false, message: "  Продолжаю\nпроверку " },
    result: { details: { ok: true, sourceReplyRoute: "current-source" } } };
  hooks.get("after_tool_call")(source, ctx);
  assert.equal(events[2].type, "turn.progress");
  assert.equal(events[2].messagePreview, "Продолжаю проверку");
  hooks.get("after_tool_call")({ ...source, params: { ...source.params, final: true } }, ctx);
  assert.equal(events[3].type, "turn.completed");
  const unreadableParams = { action: "send", final: false, get message() { throw Error("private"); } };
  hooks.get("after_tool_call")({ ...source, params: unreadableParams }, ctx);
  assert.equal(events[4].type, "turn.progress");
  assert.equal("messagePreview" in events[4], false);
  // Rejected, remote, dry-run and unrelated tool output are never inspected.
  const count = events.length;
  for (const details of [{ ok: false }, { ok: true, sourceReplyRoute: "other" },
    { ok: true, sourceReplyRoute: "current-source", nonDelivery: true }]) {
    hooks.get("after_tool_call")({ ...source, params: unreadableParams, result: { details } }, ctx);
  }
  assert.equal(events.length, count);
  hooks.get("message_received")({ content: "private inbound", messageId: "in" }, ctx);
  hooks.get("message_sent")({ content: "Готово", success: true }, ctx);
  hooks.get("message_sent")({ content: "Bearer abc", success: true }, ctx);
  hooks.get("message_sent")({ get content() { throw Error("must not read failed message"); }, success: false }, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.find(e => e.type === "message.received").messagePreview, undefined);
  const delivered = events.filter(e => e.type === "message.delivered");
  assert.equal(delivered[0].messagePreview, "Готово");
  assert.equal("messagePreview" in delivered[1], false);
  assert.equal(events.at(-1).type, "message.failed");
  assert.equal("messagePreview" in events.at(-1), false);
});

test("optional preview getters cannot suppress sanitized lifecycle events", () => {
  const base = { ...envelope(), runtime: { kind: "openclaw", version: "2026.9.1" },
    type: "turn.completed", outcome: "success", correlation: {}, details: {} };
  const output = sanitizeTelemetryEvent({ ...base, get messagePreview() { throw Error("private"); } });
  assert.equal(output.type, base.type);
  assert.equal("messagePreview" in output, false);
  assert.equal("messagePreview" in sanitizeTelemetryEvent({ ...base, messagePreview: "password=abc" }), false);
});

import { normalizeRuntimeEvent } from "../src/core/normalize.js";
test("unreadable optional preview does not change runtime normalization", () => {
  const result = normalizeRuntimeEvent("openclaw", { kind: "turn_end", outcome: "success",
    get messagePreview() { throw Error("private"); }, correlation: {} }, envelope());
  assert.equal(result.event.type, "turn.completed");
  assert.equal("messagePreview" in result.event, false);
  assert.equal(result.diagnostic, null);
});


test("ordinary words, names, paths and links survive without weakening value detection", () => {
  for (const text of ["Секреты защищены; слово секрет не является значением.",
    "memory-dreaming-promotion", "MemoryDreamingPromotion2026",
    "/usr/local/SidewispProjectDirectory2026", "src/adapters/OpenClawHooks2026", "sidewisp-pr127-eas-monitor", "Проверен /v1/activity",
    "/private/customer.txt", "C:\\private\\customer.txt", "https://example.test/docs",
    "API key protection and token usage are enabled", "Basic checks passed",
    "Aa1".repeat(8), "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890", "private information stays protected",
    "e28c9050d1e387b2fa307715fdce7ed0340623e1", "Работа завершена, статусы и cron сохранены."]) {
    assert.equal(sanitizeMessagePreview(text, "turn.completed"), text, text);
  }
  for (const text of ["api_key=abc", '"password": "abc"', "секрет: abc", "Токен=abc",
    "https://example.test/?token=abc", "https://name:abc@example.test/docs",
    "Bearer abc", "bX7qP9nR2sT4/uV6wY8zA0cD3eF5gH1jK", "AKIA1234567890ABCDEF", "gho_1234567890", "sk-proj-abc123",
    "bX7qP9nR2sT4uV6wY8zA0cD3eF5gH1jK", "api\u200b_key=abc", "ＡＰＩ＿ＫＥＹ=abc",
    "Готово ".repeat(40) + "password=after-cutoff"]) {
    assert.equal(sanitizeMessagePreview(text, "turn.completed"), undefined, text);
  }
});
