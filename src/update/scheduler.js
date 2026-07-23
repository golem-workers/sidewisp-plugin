import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HELPER = fileURLToPath(new URL("../../scripts/openclaw-update-helper.mjs", import.meta.url));

export function createUpdateScheduler({ stateDir, logger, currentVersion }) {
  let scheduledVersion = null;
  return Object.freeze({
    status: () => ({ currentVersion, scheduledVersion }),
    schedule(directive) {
      if (!validDirective(directive) || directive.targetVersion === currentVersion || directive.targetVersion === scheduledVersion) return false;
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

function validDirective(value) {
  return value?.schema === "sidewisp.plugin-update.v1"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.targetVersion)
    && typeof value.targetSpec === "string"
    && /^git:github\.com\/golem-workers\/sidewisp-plugin@(?:v?\d+\.\d+\.\d+|main)$/.test(value.targetSpec)
    && Number.isInteger(value.restartDelaySeconds)
    && value.restartDelaySeconds >= 30
    && value.restartDelaySeconds <= 3600;
}
