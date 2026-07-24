import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installRuntimeHooks,
  removeRuntimeHooks,
} from "../src/adapters/command-hook/install.js";
import { loadRuntimeHookConfig } from "../src/adapters/command-hook/config.js";

const nodePath = process.execPath;

async function installFixture(runtimeKind, runtimeVersion) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `sidewisp-${runtimeKind}-install-`));
  const settingsFile = path.join(root, "runtime", runtimeKind === "codex" ? "hooks.json" : "settings.json");
  const stateDir = path.join(root, "state");
  const installRoot = path.join(root, "install root");
  await fsp.mkdir(path.dirname(settingsFile), { recursive: true });
  await fsp.writeFile(settingsFile, `${JSON.stringify({
    existing: true,
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: "node existing-hook.js" }],
      }],
    },
  })}\n`);
  const input = {
    runtimeKind,
    runtimeVersion,
    adapterVersion: "0.2.0",
    endpoint: "https://api.sidewisp.com/private/path",
    settingsFile,
    installRoot,
    stateDir,
    nodePath,
  };
  return { root, settingsFile, stateDir, installRoot, input };
}

test("Codex hook installer merges idempotently and uninstall preserves unrelated hooks", async () => {
  const fixture = await installFixture("codex", "0.145.0");
  await installRuntimeHooks(fixture.input);
  await installRuntimeHooks(fixture.input);
  const settings = JSON.parse(await fsp.readFile(fixture.settingsFile, "utf8"));
  assert.equal(settings.existing, true);
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, "node existing-hook.js");
  for (const event of ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    const sidewisp = settings.hooks[event].flatMap(({ hooks }) => hooks)
      .filter(({ command }) => command?.includes("/scripts/runtime-hook.mjs"));
    assert.equal(sidewisp.length, 1, event);
    assert.match(sidewisp[0].command, / codex /);
  }
  const config = await loadRuntimeHookConfig(fixture.stateDir, "codex");
  assert.equal(config.runtimeVersion, "0.145.0");
  assert.equal(config.endpoint.origin, "https://api.sidewisp.com");

  await removeRuntimeHooks({ runtimeKind: "codex", settingsFile: fixture.settingsFile });
  const removed = JSON.parse(await fsp.readFile(fixture.settingsFile, "utf8"));
  assert.equal(removed.hooks.SessionStart.length, 1);
  assert.equal(removed.hooks.SessionStart[0].hooks[0].command, "node existing-hook.js");
  for (const event of ["SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    assert.equal(Object.hasOwn(removed.hooks, event), false);
  }
  assert.ok(await fsp.stat(`${fixture.settingsFile}.sidewisp-backup`));
});

test("Claude Code hook installer includes failure hooks and enforces tested baseline", async () => {
  const fixture = await installFixture("claude-code", "2.1.218");
  const result = await installRuntimeHooks(fixture.input);
  assert.ok(result.events.includes("PostToolUseFailure"));
  assert.ok(result.events.includes("StopFailure"));
  const settings = JSON.parse(await fsp.readFile(fixture.settingsFile, "utf8"));
  assert.match(settings.hooks.StopFailure[0].hooks[0].command, / claude-code /);

  await assert.rejects(() => installRuntimeHooks({
    ...fixture.input,
    runtimeVersion: "2.1.217",
  }), /2\.1\.218 or newer/);
});

test("runtime hook installer rejects invalid existing hook structures", async () => {
  const fixture = await installFixture("codex", "0.145.0");
  await fsp.writeFile(fixture.settingsFile, `${JSON.stringify({ hooks: [] })}\n`);
  await assert.rejects(() => installRuntimeHooks(fixture.input), /settings\.hooks must be an object/);
});
