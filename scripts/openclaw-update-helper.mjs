#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isNewerVersion, validUpdateDirective } from "../src/update/directive.js";

const directive = JSON.parse(process.argv[2] ?? "null");
if (!directive?.stateFile || !validUpdateDirective(directive)) process.exit(2);
const stateFile = path.resolve(directive.stateFile);
mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });

const writeState = (state) => {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...state, targetVersion: directive.targetVersion, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(temp, stateFile);
};
const run = (args) => execFileSync("openclaw", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const inspectInstalled = () => {
  const inspected = JSON.parse(run(["plugins", "inspect", "sidewisp", "--runtime", "--json"]));
  const pluginPath = inspected.path ?? inspected.plugin?.path ?? inspected.runtime?.path;
  if (typeof pluginPath !== "string" || !existsSync(pluginPath)) throw new Error("installed plugin path unavailable");
  const pluginRoot = [pluginPath, path.dirname(pluginPath)]
    .find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!pluginRoot) throw new Error("installed plugin package unavailable");
  const version = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
  if (typeof version !== "string") throw new Error("installed plugin version unavailable");
  return { pluginRoot, version };
};
const waitForGateway = async () => {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const output = run(["gateway", "call", "sidewisp.status", "--params", "{}", "--json"]);
      if (JSON.parse(output).version === directive.targetVersion) return;
    } catch { /* gateway is still restarting */ }
    await sleep(5_000);
  }
  throw new Error("target plugin version did not become healthy");
};

writeState({ status: "scheduled" });
await sleep(directive.restartDelaySeconds * 1000);

let backup = null;
try {
  writeState({ status: "updating" });
  const installed = inspectInstalled();
  if (!isNewerVersion(directive.targetVersion, installed.version)) {
    writeState({ status: "skipped", reasonCode: "TARGET_NOT_NEWER" });
    process.exit(0);
  }
  backup = path.join(path.dirname(stateFile), `rollback-${Date.now()}`);
  cpSync(installed.pluginRoot, backup, { recursive: true, errorOnExist: true });
  run(["plugins", "install", directive.targetSpec, "--force"]);
  const updated = inspectInstalled();
  if (updated.version !== directive.targetVersion) throw new Error("installed plugin version mismatch");
  writeState({ status: "restarting" });
  run(["gateway", "restart"]);
  await waitForGateway();
  writeState({ status: "completed" });
  if (backup) rmSync(backup, { recursive: true, force: true });
} catch (error) {
  writeState({ status: "rolling_back", errorCode: "UPDATE_OR_RESTART_FAILED" });
  try {
    if (backup) {
      const installed = inspectInstalled();
      rmSync(installed.pluginRoot, { recursive: true, force: true });
      cpSync(backup, installed.pluginRoot, { recursive: true });
    }
    run(["gateway", "restart"]);
    writeState({ status: "rolled_back", errorCode: "UPDATE_OR_RESTART_FAILED" });
  } catch {
    writeState({ status: "failed", errorCode: "ROLLBACK_FAILED" });
  }
}
