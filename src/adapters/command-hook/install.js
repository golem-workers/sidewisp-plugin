import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { CLAUDE_CODE_HOOK_EVENTS } from "../claude-code/hooks.js";
import { CODEX_HOOK_EVENTS } from "../codex/hooks.js";
import { writeRuntimeHookConfig } from "./config.js";

const RUNTIME_EVENTS = Object.freeze({
  codex: CODEX_HOOK_EVENTS,
  "claude-code": CLAUDE_CODE_HOOK_EVENTS,
});
const MINIMUM_VERSIONS = Object.freeze({
  codex: "0.145.0",
  "claude-code": "2.1.218",
});

function assertAbsolute(name, value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
}

function parseVersion(value) {
  const match = typeof value === "string" ? value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/) : null;
  if (!match) throw new TypeError("runtimeVersion must be semantic");
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function isSidewispHandler(handler, runtimeKind) {
  const command = handler && typeof handler === "object" ? handler.command : null;
  return typeof command === "string" &&
    command.includes("/scripts/runtime-hook.mjs") &&
    command.includes(` ${runtimeKind} `);
}

function removeRuntimeHandlers(settings, runtimeKind) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return settings;
  for (const event of RUNTIME_EVENTS[runtimeKind]) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = groups.flatMap((group) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter((handler) => !isSidewispHandler(handler, runtimeKind));
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
  return settings;
}

async function readSettings(file) {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("settings must be an object");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettings(file, settings) {
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fsp.stat(file).catch(() => null)) {
    await fsp.copyFile(file, `${file}.sidewisp-backup`, fsConstants.COPYFILE_EXCL).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, file);
    await fsp.chmod(file, 0o600);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function buildRuntimeHookCommand({ nodePath, installRoot, runtimeKind, stateDir }) {
  assertAbsolute("nodePath", nodePath);
  assertAbsolute("installRoot", installRoot);
  assertAbsolute("stateDir", stateDir);
  if (!RUNTIME_EVENTS[runtimeKind]) throw new RangeError("unsupported runtime");
  return [
    shellQuote(nodePath),
    shellQuote(path.join(installRoot, "current", "scripts", "runtime-hook.mjs")),
    runtimeKind,
    shellQuote(stateDir),
  ].join(" ");
}

export async function installRuntimeHooks({
  runtimeKind,
  runtimeVersion,
  adapterVersion,
  endpoint,
  settingsFile,
  installRoot,
  stateDir,
  nodePath,
}) {
  if (!RUNTIME_EVENTS[runtimeKind]) throw new RangeError("unsupported runtime");
  if (compareVersions(runtimeVersion, MINIMUM_VERSIONS[runtimeKind]) < 0) {
    throw new RangeError(`${runtimeKind} ${MINIMUM_VERSIONS[runtimeKind]} or newer is required`);
  }
  assertAbsolute("settingsFile", settingsFile);
  const command = buildRuntimeHookCommand({ nodePath, installRoot, runtimeKind, stateDir });
  const settings = removeRuntimeHandlers(await readSettings(settingsFile), runtimeKind);
  if (settings.hooks === undefined) settings.hooks = {};
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new TypeError("settings.hooks must be an object");
  }
  for (const event of RUNTIME_EVENTS[runtimeKind]) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    settings.hooks[event].push({
      matcher: "*",
      hooks: [{
        type: "command",
        command,
        timeout: event === "SessionEnd" ? 3 : 5,
      }],
    });
  }
  await writeRuntimeHookConfig({
    stateDir,
    runtimeKind,
    runtimeVersion,
    adapterVersion,
    endpoint,
    hookCommand: command,
  });
  await writeSettings(settingsFile, settings);
  return { command, events: [...RUNTIME_EVENTS[runtimeKind]], settingsFile };
}

export async function removeRuntimeHooks({ runtimeKind, settingsFile }) {
  if (!RUNTIME_EVENTS[runtimeKind]) throw new RangeError("unsupported runtime");
  assertAbsolute("settingsFile", settingsFile);
  const settings = removeRuntimeHandlers(await readSettings(settingsFile), runtimeKind);
  await writeSettings(settingsFile, settings);
  return { events: [...RUNTIME_EVENTS[runtimeKind]], settingsFile };
}
