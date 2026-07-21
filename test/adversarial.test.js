import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";

import { parseOpenClawRecord, recoverJsonl } from "../src/adapters/openclaw/recovery.js";
import { sanitizeTelemetryEvent } from "../src/core/sanitize.js";

const fixtureDir = path.join(import.meta.dirname, "fixtures");

function envelope(index, details = {}) {
  return {
    eventId: `sw_evt_fixture_${index}`,
    installationId: "sw_ins_fixture001",
    sequence: index,
    occurredAt: "2026-07-21T00:00:00.000Z",
    observedAt: "2026-07-21T00:00:00.000Z",
    runtime: { kind: "openclaw", version: "2026.7.1" },
    source: { kind: "hook", adapterVersion: "0.1.0" },
    type: "turn.failed",
    outcome: "failure",
    correlation: { sessionId: "session_fixture" },
    details,
  };
}

test("golden OpenClaw and Hermes fixtures describe equivalent bounded facts", async () => {
  const openclaw = (await fs.readFile(path.join(fixtureDir, "openclaw-golden.jsonl"), "utf8"))
    .trim().split("\n").map((line) => parseOpenClawRecord(JSON.parse(line)));
  const hermes = JSON.parse(await fs.readFile(path.join(fixtureDir, "hermes-golden.json"), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(openclaw)), hermes);
  assert.equal(JSON.stringify(openclaw).includes("prompt"), false);
});

test("deterministic hostile-record corpus never throws or emits unbounded fields", () => {
  let state = 0x5eed1234;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  const atoms = [null, true, false, 0, -1, "", "\ud800", [], {}, { event: "unknown" }];
  for (let index = 0; index < 10_000; index += 1) {
    const record = { event: ["agent_start", "tool_end", "message_sent", "unknown"][next() % 4] };
    for (const key of ["sessionId", "runId", "toolCallId", "messageId", "outcome", "durationMs"]) record[key] = atoms[next() % atoms.length];
    const fact = parseOpenClawRecord(record);
    if (fact) assert.ok(Buffer.byteLength(JSON.stringify(fact)) < 1024);
  }
});

test("malformed UTF-8, oversized JSON, truncation, and partial tails stay bounded", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-adversarial-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "hostile.jsonl");
  const malformed = Buffer.from([0xff, 0xfe, 0xfd, 0x0a]);
  const oversized = Buffer.from(`${JSON.stringify({ event: "agent_start", ignored: "x".repeat(70_000) })}\n`);
  const valid = Buffer.from(`${JSON.stringify({ event: "gateway_start" })}\n{\"event\":`);
  await fs.writeFile(file, Buffer.concat([malformed, oversized, valid]));
  const result = await recoverJsonl(file, null, { maxReadBytes: 80_000, maxLineBytes: 1024, maxLines: 10 });
  assert.deepEqual(result.facts, [{ kind: "gateway_up", outcome: undefined, correlation: {}, durationMs: undefined }]);
  assert.equal(result.diagnostics.rejected, 2);
  assert.ok(Buffer.byteLength(result.cursor.partial) <= 1024);
});

test("sanitization throughput and memory remain inside collector budgets", () => {
  const count = 20_000;
  const beforeHeap = process.memoryUsage().heapUsed;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) sanitizeTelemetryEvent(envelope(index, { code: "fixture-failure", attempt: index % 3 }));
  const elapsedMs = performance.now() - started;
  const heapGrowth = process.memoryUsage().heapUsed - beforeHeap;
  assert.ok(elapsedMs < 2_000, `sanitization budget exceeded: ${elapsedMs.toFixed(1)}ms`);
  assert.ok(heapGrowth < 32 * 1024 * 1024, `heap budget exceeded: ${heapGrowth} bytes`);
});

test("secret corpus fails closed without reproducing values", () => {
  for (const [index, secret] of ["Bearer abc123", "api_key-value", "password-value", "https://user:pass@example.test"].entries()) {
    let error;
    try { sanitizeTelemetryEvent(envelope(index, { code: secret })); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.equal(String(error).includes(secret), false);
  }
});
