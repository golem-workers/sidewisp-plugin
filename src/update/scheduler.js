import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validUpdateDirective } from "./directive.js";

const HELPER = fileURLToPath(new URL("../../scripts/openclaw-update-helper.mjs", import.meta.url));

export function createUpdateScheduler({ stateDir, logger, currentVersion }) {
  let scheduledVersion = null;
  return Object.freeze({
    status: () => ({ currentVersion, scheduledVersion }),
    schedule(directive) {
      if (!validUpdateDirective(directive) || directive.targetVersion === currentVersion || directive.targetVersion === scheduledVersion) return false;
      scheduledVersion = directive.targetVersion;
      const child = spawn(process.execPath, [HELPER, JSON.stringify({
        ...directive,
        stateFile: path.join(stateDir, "sidewisp", "update-status.json"),
      })], { detached: true, stdio: "ignore", env: process.env });
      child.unref();
      logger.info(`Sidewisp ${directive.targetVersion} update scheduled in ${directive.restartDelaySeconds}s`);
      return true;
    },
  });
}
