import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isNewerVersion, validUpdateDirective } from "./directive.js";

const HELPER = fileURLToPath(new URL("../../scripts/openclaw-update-helper.mjs", import.meta.url));

const SAFE_ENV_KEYS = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "PATH",
  "USER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

function safeHelperEnvironment(environment) {
  return Object.fromEntries(SAFE_ENV_KEYS
    .filter((key) => typeof environment[key] === "string")
    .map((key) => [key, environment[key]]));
}

function systemdUnitName(version) {
  return `sidewisp-update-${version.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function createUpdateScheduler({ stateDir, logger, currentVersion, spawnImpl = spawn }) {
  let scheduledVersion = null;
  return Object.freeze({
    status: () => ({ currentVersion, scheduledVersion }),
    schedule(directive) {
      if (!validUpdateDirective(directive)
        || !isNewerVersion(directive.targetVersion, currentVersion)
        || directive.targetVersion === scheduledVersion) return false;
      scheduledVersion = directive.targetVersion;
      const payload = JSON.stringify({
        ...directive,
        stateFile: path.join(stateDir, "sidewisp", "update-status.json"),
      });
      const environment = safeHelperEnvironment(process.env);
      const insideSystemdUserService = process.platform === "linux"
        && typeof process.env.INVOCATION_ID === "string"
        && process.env.INVOCATION_ID.length > 0;
      const command = insideSystemdUserService ? "systemd-run" : process.execPath;
      const args = insideSystemdUserService
        ? [
          "--user",
          "--quiet",
          "--collect",
          `--unit=${systemdUnitName(directive.targetVersion)}`,
          "--property=Type=exec",
          ...Object.entries(environment).map(([key, value]) => `--setenv=${key}=${value}`),
          process.execPath,
          HELPER,
          payload,
        ]
        : [HELPER, payload];
      const child = spawnImpl(command, args, {
        detached: true,
        stdio: "ignore",
        env: environment,
      });
      child.unref();
      logger.info(`Sidewisp ${directive.targetVersion} update scheduled in ${directive.restartDelaySeconds}s`);
      return true;
    },
  });
}
