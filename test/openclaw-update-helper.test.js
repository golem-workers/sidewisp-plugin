import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../scripts/openclaw-update-helper.mjs", import.meta.url));

test("OpenClaw helper rechecks the installed version before a delayed update", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sidewisp-openclaw-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const pluginRoot = path.join(root, "plugin");
  const logFile = path.join(root, "openclaw.log");
  const stateFile = path.join(root, "update-status.json");
  const preload = path.join(root, "skip-delay.mjs");
  mkdirSync(bin);
  mkdirSync(pluginRoot);
  writeFileSync(path.join(pluginRoot, "package.json"), `${JSON.stringify({ version: "0.2.18" })}\n`);
  writeFileSync(preload, "globalThis.setTimeout = (fn) => { queueMicrotask(fn); return { unref() {} }; };\n");
  const openclaw = path.join(bin, "openclaw");
  writeFileSync(openclaw, `#!/bin/sh
printf '%s\\n' "$*" >> "$SIDEWISP_TEST_LOG"
if [ "$1 $2 $3" = "plugins inspect sidewisp" ]; then
  printf '{"path":"%s"}\\n' "$SIDEWISP_TEST_PLUGIN_ROOT"
  exit 0
fi
exit 90
`);
  chmodSync(openclaw, 0o755);

  execFileSync(process.execPath, ["--import", preload, helper, JSON.stringify({
    schema: "sidewisp.plugin-update.v1",
    targetVersion: "0.2.17",
    targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.2.17",
    restartDelaySeconds: 30,
    stateFile,
  })], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SIDEWISP_TEST_LOG: logFile,
      SIDEWISP_TEST_PLUGIN_ROOT: pluginRoot,
    },
    stdio: "pipe",
  });

  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(state.status, "skipped");
  assert.equal(state.reasonCode, "TARGET_NOT_NEWER");
  assert.deepEqual(readFileSync(logFile, "utf8").trim().split("\n"), [
    "plugins inspect sidewisp --runtime --json",
  ]);
});
