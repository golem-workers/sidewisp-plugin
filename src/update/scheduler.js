import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isNewerVersion, validUpdateDirective } from "./directive.js";

const HELPER = fileURLToPath(new URL("../../scripts/openclaw-update-helper.mjs", import.meta.url));
const ACTIVE_ATTEMPT_TTL_MS = 2 * 60_000;
const TERMINAL_UPDATE_STATES = new Set(["completed", "failed", "rolled_back", "skipped"]);
const UNSAFE_STALE_STATES = new Set(["updating", "restarting", "verifying"]);

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

function readAttempt(stateFile) {
  try {
    const value = JSON.parse(readFileSync(stateFile, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function blocksAttempt(stateFile, targetVersion, nowMs) {
  const attempt = readAttempt(stateFile);
  if (attempt?.targetVersion !== targetVersion || typeof attempt.status !== "string") return null;
  if (TERMINAL_UPDATE_STATES.has(attempt.status) || UNSAFE_STALE_STATES.has(attempt.status)) return attempt;
  const updatedAt = Date.parse(attempt.updatedAt ?? "");
  return Number.isFinite(updatedAt) && nowMs - updatedAt <= ACTIVE_ATTEMPT_TTL_MS ? attempt : null;
}

export function createUpdateScheduler({ stateDir, logger, currentVersion, spawnImpl = spawn, now = Date.now }) {
  let scheduledVersion = null;
  const stateFile = path.join(stateDir, "sidewisp", "update-status.json");
  return Object.freeze({
    status: () => {
      const attempt = readAttempt(stateFile);
      return {
        currentVersion,
        scheduledVersion,
        ...(attempt ? { lastAttempt: {
          targetVersion: attempt.targetVersion,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
          reasonCode: attempt.reasonCode,
        } } : {}),
      };
    },
    schedule(directive) {
      if (!validUpdateDirective(directive)
        || !isNewerVersion(directive.targetVersion, currentVersion)
        || directive.targetVersion === scheduledVersion
        || blocksAttempt(stateFile, directive.targetVersion, now())) return false;
      scheduledVersion = directive.targetVersion;
      const payload = JSON.stringify({
        ...directive,
        stateFile,
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
