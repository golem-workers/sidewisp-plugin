#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const directive = JSON.parse(process.argv[2] ?? "null");
if (!directive?.stateFile || !directive?.targetVersion || !/^git:github\.com\/golem-workers\/sidewisp-plugin@v?\d+\.\d+\.\d+$/.test(directive.targetSpec)) process.exit(2);
const stateFile = path.resolve(directive.stateFile);
mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });

const writeState = (state) => {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...state, targetVersion: directive.targetVersion, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  renameSync(temp, stateFile);
};
const run = (args) => execFileSync("openclaw", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

writeState({ status: "scheduled" });
await sleep(directive.restartDelaySeconds * 1000);

let backup = null;
try {
  writeState({ status: "updating" });
  const inspected = JSON.parse(run(["plugins", "inspect", "sidewisp", "--runtime", "--json"]));
  const pluginPath = inspected.path ?? inspected.plugin?.path ?? inspected.runtime?.path;
  if (typeof pluginPath === "string" && existsSync(pluginPath)) {
    backup = path.join(path.dirname(stateFile), `rollback-${Date.now()}`);
    cpSync(pluginPath, backup, { recursive: true, errorOnExist: true });
  }
  run(["plugins", "install", directive.targetSpec, "--force"]);
  run(["plugins", "inspect", "sidewisp", "--runtime", "--json"]);
  writeState({ status: "restarting" });
  run(["gateway", "restart"]);
  writeState({ status: "completed" });
  if (backup) rmSync(backup, { recursive: true, force: true });
} catch (error) {
  writeState({ status: "rolling_back", errorCode: "UPDATE_OR_RESTART_FAILED" });
  try {
    if (backup) {
      const inspected = JSON.parse(run(["plugins", "inspect", "sidewisp", "--runtime", "--json"]));
      const pluginPath = inspected.path ?? inspected.plugin?.path ?? inspected.runtime?.path;
      if (typeof pluginPath === "string") {
        rmSync(pluginPath, { recursive: true, force: true });
        cpSync(backup, pluginPath, { recursive: true });
      }
    }
    run(["gateway", "restart"]);
    writeState({ status: "rolled_back", errorCode: "UPDATE_OR_RESTART_FAILED" });
  } catch {
    writeState({ status: "failed", errorCode: "ROLLBACK_FAILED" });
  }
}
