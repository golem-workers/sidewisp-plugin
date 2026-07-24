import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFileCredentialStore } from "../src/auth/credentials.js";
import { writeRuntimeHookConfig } from "../src/adapters/command-hook/config.js";
import { openSpool } from "../src/delivery/spool.js";

const script = fileURLToPath(new URL("../scripts/runtime-hook.mjs", import.meta.url));

async function waitForWorker(stateDir) {
  const spoolFile = path.join(stateDir, "sidewisp", "spool.sqlite");
  const lockFile = `${spoolFile}.lock`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const exists = await fsp.stat(spoolFile).catch(() => null);
    const locked = await fsp.stat(lockFile).catch(() => null);
    if (exists && !locked) return spoolFile;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("runtime hook worker did not flush staged event");
}

test("runtime hook command never blocks Codex and retains events across upload outage", async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sidewisp-runtime-hook-script-"));
  await writeRuntimeHookConfig({
    stateDir,
    runtimeKind: "codex",
    runtimeVersion: "0.145.0",
    adapterVersion: "0.2.0",
    endpoint: "https://127.0.0.1:9",
    hookCommand: "fixture",
  });
  await createFileCredentialStore({ stateDir }).write({
    installationId: "sw_ins_hookscript1",
    secret: `sw_secret_${"x".repeat(32)}`,
    status: "active",
  });
  const result = spawnSync(process.execPath, [script, "codex", stateDir], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "thr_1",
      turn_id: "turn_1",
      tool_use_id: "call_1",
      tool_name: "Bash",
      tool_input: { command: "private command" },
      tool_response: { exit_code: 1, stderr: "private error" },
    }),
    timeout: 2_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const spoolFile = await waitForWorker(stateDir);
  const spool = await openSpool({ file: spoolFile });
  const pending = spool.pending(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event.type, "tool.failed");
  assert.equal(JSON.stringify(pending).includes("private"), false);
  await spool.close();
});

test("malformed runtime hook input is swallowed without stdout or stderr", async () => {
  const result = spawnSync(process.execPath, [script, "codex", "/missing"], {
    encoding: "utf8",
    input: "{bad-json",
    timeout: 2_000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
