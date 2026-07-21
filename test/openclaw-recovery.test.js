import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverOpenClawSources, parseOpenClawRecord, recoverJsonl, stableOpenClawEventId } from "../src/adapters/openclaw/recovery.js";

test("version-aware discovery reports unsupported runtimes explicitly", async () => {
  const result = await discoverOpenClawSources("/missing", "2025.1.0");
  assert.deepEqual(result.sources, []);
  assert.equal(result.diagnostic.code, "unsupported-openclaw-version");
});

test("typed parser ignores generic WARN/ERROR and raw content", () => {
  assert.equal(parseOpenClawRecord({ level: "ERROR", message: "private generic error" }), null);
  assert.deepEqual(parseOpenClawRecord({ event: "tool_end", outcome: "failure", toolCallId: "tool-1", result: "private" }), {
    kind: "tool_end", outcome: "failure", correlation: { toolCallId: "tool-1" }, durationMs: undefined,
  });
});

test("bounded JSONL recovery handles partial lines, rotation, and hostile input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "gateway.jsonl");
  await fs.writeFile(file, '{"event":"tool_end","outcome":"failure","toolCallId":"a"}\n{"event":"agent_end"');
  const first = await recoverJsonl(file, null, { maxReadBytes: 4096 });
  assert.equal(first.facts.length, 1);
  assert.ok(first.cursor.partial.includes("agent_end"));
  await fs.appendFile(file, ',"outcome":"success","runId":"r"}\nnot-json\n');
  const second = await recoverJsonl(file, first.cursor);
  assert.equal(second.facts[0].kind, "turn_end");
  assert.equal(second.diagnostics.rejected, 1);
  await fs.rename(file, `${file}.1`);
  await fs.writeFile(file, '{"event":"gateway_start"}\n');
  const rotated = await recoverJsonl(file, second.cursor);
  assert.equal(rotated.diagnostics.rotated, true);
  assert.equal(rotated.facts[0].kind, "gateway_up");
});

test("hook and recovery facts share a stable deduplication id", () => {
  const hook = { kind: "tool_end", correlation: { sessionId: "s", turnId: "r", toolCallId: "t" } };
  const recovered = parseOpenClawRecord({ event: "tool_end", sessionId: "s", runId: "r", toolCallId: "t", outcome: "failure" });
  assert.equal(stableOpenClawEventId(hook), stableOpenClawEventId(recovered));
});
