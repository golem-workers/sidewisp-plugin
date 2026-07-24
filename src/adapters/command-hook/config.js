import fsp from "node:fs/promises";
import path from "node:path";

const CONFIG_SCHEMA = "sidewisp.runtime-hook-config.v1";
const RUNTIMES = new Set(["codex", "claude-code"]);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export async function loadRuntimeHookConfig(stateDir, expectedRuntimeKind) {
  if (!path.isAbsolute(stateDir)) throw new TypeError("stateDir must be absolute");
  if (!RUNTIMES.has(expectedRuntimeKind)) throw new RangeError("unsupported runtime");
  const file = path.join(stateDir, "sidewisp", "runtime-hook.json");
  const value = JSON.parse(await fsp.readFile(file, "utf8"));
  if (value?.schema !== CONFIG_SCHEMA || value.runtimeKind !== expectedRuntimeKind) {
    throw new TypeError("invalid runtime hook config");
  }
  const endpoint = new URL(value.endpoint);
  if (endpoint.protocol !== "https:") throw new TypeError("runtime hook endpoint must use HTTPS");
  if (typeof value.runtimeVersion !== "string" || !SAFE_VERSION.test(value.runtimeVersion)) {
    throw new TypeError("invalid runtime version");
  }
  if (typeof value.adapterVersion !== "string" || !SAFE_VERSION.test(value.adapterVersion)) {
    throw new TypeError("invalid adapter version");
  }
  return Object.freeze({
    runtimeKind: value.runtimeKind,
    runtimeVersion: value.runtimeVersion,
    adapterVersion: value.adapterVersion,
    endpoint,
  });
}

export async function writeRuntimeHookConfig({
  stateDir,
  runtimeKind,
  runtimeVersion,
  adapterVersion,
  endpoint,
  hookCommand,
}) {
  if (!path.isAbsolute(stateDir)) throw new TypeError("stateDir must be absolute");
  if (!RUNTIMES.has(runtimeKind)) throw new RangeError("unsupported runtime");
  const targetEndpoint = new URL(endpoint);
  if (targetEndpoint.protocol !== "https:") throw new TypeError("runtime hook endpoint must use HTTPS");
  for (const [name, value] of Object.entries({ runtimeVersion, adapterVersion })) {
    if (typeof value !== "string" || !SAFE_VERSION.test(value)) throw new TypeError(`invalid ${name}`);
  }
  if (typeof hookCommand !== "string" || hookCommand.length < 1 || hookCommand.length > 4096) {
    throw new TypeError("invalid hook command");
  }
  const directory = path.join(stateDir, "sidewisp");
  const file = path.join(directory, "runtime-hook.json");
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700);
  try {
    await fsp.writeFile(temporary, `${JSON.stringify({
      schema: CONFIG_SCHEMA,
      runtimeKind,
      runtimeVersion,
      adapterVersion,
      endpoint: targetEndpoint.origin,
      hookCommand,
    })}\n`, { mode: 0o600, flag: "wx" });
    await fsp.rename(temporary, file);
    await fsp.chmod(file, 0o600);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}
