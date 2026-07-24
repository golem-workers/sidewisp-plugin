import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  importHookInbox,
  readHookPayload,
  stageRuntimeHook,
} from "../src/adapters/command-hook/bridge.js";
import { openSpool } from "../src/delivery/spool.js";

test("command hook bridge stages only sanitized telemetry and imports atomically", async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sidewisp-command-hook-"));
  const result = await stageRuntimeHook({
    runtimeKind: "codex",
    payload: {
      hook_event_name: "PostToolUse",
      session_id: "thr_1",
      turn_id: "turn_1",
      tool_use_id: "call_1",
      tool_name: "Bash",
      prompt: "private prompt",
      tool_input: { command: "private command", password: "forbidden" },
      tool_response: { exit_code: 1, stdout: "private output", stderr: "private error" },
      transcript_path: "/private/transcript.jsonl",
    },
    stateDir,
    installationId: "sw_ins_commandhook1",
    runtimeVersion: "0.145.0",
    adapterVersion: "0.2.0",
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    randomUUID: () => "00000000-0000-4000-8000-000000000001",
  });
  assert.equal(result.staged, 1);
  const inbox = path.join(stateDir, "sidewisp", "hook-inbox");
  const files = await fsp.readdir(inbox);
  assert.equal(files.length, 1);
  const serialized = await fsp.readFile(path.join(inbox, files[0]), "utf8");
  for (const forbidden of ["private prompt", "private command", "private output", "private error", "forbidden", "transcript"]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  const spool = await openSpool({ file: path.join(stateDir, "sidewisp", "spool.sqlite") });
  const imported = await importHookInbox({ runtimeKind: "codex", stateDir, spool });
  assert.deepEqual(imported, { imported: 1, rejected: 0 });
  assert.equal(spool.pending(10).length, 1);
  assert.equal((await fsp.readdir(inbox)).length, 0);
  await spool.close();
});

test("command hook bridge bounds stdin and rejects unknown runtimes", async () => {
  const payload = await readHookPayload(Readable.from([JSON.stringify({ hook_event_name: "Stop" })]));
  assert.equal(payload.hook_event_name, "Stop");
  await assert.rejects(
    () => readHookPayload(Readable.from(["x".repeat(32)]), { maxBytes: 16 }),
    /byte limit/,
  );
  await assert.rejects(() => stageRuntimeHook({
    runtimeKind: "unknown",
    payload: {},
    stateDir: "/tmp",
    installationId: "sw_ins_fixture1",
    adapterVersion: "0.2.0",
  }), /unsupported command-hook runtime/);
});
