import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validUpdateDirective } from "./directive.js";

const HELPER = fileURLToPath(new URL("../../scripts/hermes-update-helper.mjs", import.meta.url));

export function createHermesUpdateScheduler({
  stateDir, installRoot, currentVersion, serviceManager, logger = console, spawnImpl = spawn,
}) {
  let scheduledVersion = null;
  return Object.freeze({
    schedule(directive) {
      if (!validUpdateDirective(directive)
        || !/^[a-f0-9]{64}$/.test(directive.sha256 ?? "")
        || directive.targetVersion === currentVersion
        || directive.targetVersion === scheduledVersion) return false;
      scheduledVersion = directive.targetVersion;
      const child = spawnImpl(process.execPath, [HELPER, JSON.stringify({
        ...directive,
        stateFile: path.join(stateDir, "sidewisp", "update-status.json"),
        collectorStatusFile: path.join(stateDir, "sidewisp", "collector-status.json"),
        installRoot,
        serviceManager,
      })], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH } });
      child.unref();
      logger.info?.(`Sidewisp Hermes ${directive.targetVersion} update scheduled in ${directive.restartDelaySeconds}s`);
      return true;
    },
    status: () => ({ currentVersion, scheduledVersion }),
  });
}
