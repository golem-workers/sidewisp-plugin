import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { normalizeRuntimeEvent } from "../../core/normalize.js";
import { sanitizeTelemetryEvent } from "../../core/sanitize.js";
import { claudeCodeHookInputs } from "../claude-code/hooks.js";
import { codexHookInputs } from "../codex/hooks.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const RUNTIMES = new Set(["codex", "claude-code"]);
const EVENT_FILE = /^sw_evt_[A-Za-z0-9_-]{32}\.json$/;
const INPUT_MAPPERS = Object.freeze({
  codex: codexHookInputs,
  "claude-code": claudeCodeHookInputs,
});

function assertRuntimeKind(runtimeKind) {
  if (!RUNTIMES.has(runtimeKind)) throw new RangeError(`unsupported command-hook runtime: ${runtimeKind}`);
}

export async function readHookPayload(stream, { maxBytes = MAX_INPUT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INPUT_BYTES) {
    throw new RangeError("maxBytes is invalid");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw new RangeError("hook input exceeds byte limit");
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("hook input must be an object");
  return parsed;
}

export function runtimeHookInputs(runtimeKind, payload) {
  assertRuntimeKind(runtimeKind);
  return INPUT_MAPPERS[runtimeKind](payload);
}

export async function stageRuntimeHook({
  runtimeKind,
  payload,
  stateDir,
  installationId,
  runtimeVersion = "unknown",
  adapterVersion,
  now = () => new Date(),
  randomUUID = crypto.randomUUID,
}) {
  assertRuntimeKind(runtimeKind);
  if (!path.isAbsolute(stateDir)) throw new TypeError("stateDir must be absolute");
  const inputs = runtimeHookInputs(runtimeKind, payload);
  if (inputs.length === 0) return { staged: 0, eventIds: [] };
  const inbox = path.join(stateDir, "sidewisp", "hook-inbox");
  await fsp.mkdir(inbox, { recursive: true, mode: 0o700 });
  await fsp.chmod(inbox, 0o700);
  const eventIds = [];
  const observed = now();
  for (const [index, input] of inputs.entries()) {
    const identity = `${runtimeKind}\0${payload.hook_event_name ?? ""}\0${payload.session_id ?? ""}\0${payload.turn_id ?? ""}\0${payload.tool_use_id ?? ""}\0${randomUUID()}\0${index}`;
    const digest = crypto.createHash("sha256").update(identity).digest("base64url").slice(0, 32);
    const eventId = `sw_evt_${digest}`;
    const observedAt = new Date(observed.getTime() + index).toISOString();
    const normalized = normalizeRuntimeEvent(runtimeKind, input, {
      eventId,
      installationId,
      sequence: observed.getTime() * 10 + index,
      occurredAt: observedAt,
      observedAt,
      runtime: { version: runtimeVersion },
      source: { kind: "hook", adapterVersion },
      correlation: input.correlation ?? {},
      details: {},
    });
    if (!normalized.event) continue;
    const temporary = path.join(inbox, `.${eventId}.${process.pid}.${randomUUID()}.tmp`);
    const target = path.join(inbox, `${eventId}.json`);
    try {
      await fsp.writeFile(temporary, `${JSON.stringify(normalized.event)}\n`, { mode: 0o600, flag: "wx" });
      await fsp.rename(temporary, target);
      eventIds.push(eventId);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { staged: eventIds.length, eventIds };
}

export async function importHookInbox({ runtimeKind, stateDir, spool, limit = 1000 }) {
  assertRuntimeKind(runtimeKind);
  if (!path.isAbsolute(stateDir)) throw new TypeError("stateDir must be absolute");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit is invalid");
  const inbox = path.join(stateDir, "sidewisp", "hook-inbox");
  let entries;
  try {
    entries = await fsp.readdir(inbox, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { imported: 0, rejected: 0 };
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && EVENT_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, limit);
  let imported = 0;
  let rejected = 0;
  for (const name of files) {
    const file = path.join(inbox, name);
    try {
      const stat = await fsp.stat(file);
      if (stat.size > MAX_EVENT_BYTES) throw new RangeError("staged event exceeds byte limit");
      const event = sanitizeTelemetryEvent(JSON.parse(await fsp.readFile(file, "utf8")));
      if (event.runtime.kind !== runtimeKind) throw new TypeError("staged event runtime mismatch");
      spool.enqueueSourceBatch(`command-hook:${runtimeKind}`, event.eventId, [event]);
      await fsp.unlink(file);
      imported += 1;
    } catch {
      const rejectedDir = path.join(inbox, "rejected");
      await fsp.mkdir(rejectedDir, { recursive: true, mode: 0o700 });
      await fsp.rename(file, path.join(rejectedDir, `${name}.invalid`)).catch(() => {});
      rejected += 1;
    }
  }
  return { imported, rejected };
}
