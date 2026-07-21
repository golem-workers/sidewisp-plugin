import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SUPPORTED_VERSION = /^2026\.7\./;
const EVENT_MAP = Object.freeze({
  agent_start: "turn_start", agent_end: "turn_end", tool_start: "tool_start", tool_end: "tool_end",
  message_received: "message_received", message_sent: "delivery_end", gateway_start: "gateway_up", gateway_stop: "gateway_down",
});

export function stableOpenClawEventId(fact, fallback = "") {
  const correlation = fact.correlation ?? {};
  const identity = [fact.kind, correlation.sessionId, correlation.turnId, correlation.toolCallId, correlation.messageId].filter(Boolean).join("|") || `${fact.kind}|${fallback}`;
  return `sw_evt_${crypto.createHash("sha256").update(`openclaw|${identity}`).digest("base64url").slice(0, 32)}`;
}

export async function discoverOpenClawSources(stateDir, runtimeVersion) {
  if (!SUPPORTED_VERSION.test(runtimeVersion)) return { sources: [], diagnostic: { localOnly: true, code: "unsupported-openclaw-version", runtimeVersion } };
  const candidates = [path.join(stateDir, "logs", "gateway.jsonl"), path.join(stateDir, "logs", "openclaw.jsonl")];
  const agents = path.join(stateDir, "agents");
  try {
    for (const agent of (await fs.readdir(agents)).slice(0, 100)) {
      const sessions = path.join(agents, agent, "sessions");
      try { for (const file of (await fs.readdir(sessions)).slice(0, 1000)) if (file.endsWith(".jsonl")) candidates.push(path.join(sessions, file)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const sources = [];
  for (const file of candidates) {
    try { const stat = await fs.stat(file); if (stat.isFile()) sources.push({ file, dev: stat.dev, ino: stat.ino }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { sources, diagnostic: null };
}

export function parseOpenClawRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const kind = EVENT_MAP[record.event];
  if (!kind) return null;
  const correlation = {};
  for (const [source, target] of [["sessionId", "sessionId"], ["runId", "turnId"], ["toolCallId", "toolCallId"], ["messageId", "messageId"]]) {
    if (typeof record[source] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(record[source])) correlation[target] = record[source];
  }
  const outcome = ["success", "failure", "cancelled", "timeout", "policy-rejected"].includes(record.outcome) ? record.outcome : undefined;
  return { kind, outcome, correlation, durationMs: Number.isSafeInteger(record.durationMs) && record.durationMs >= 0 ? record.durationMs : undefined };
}

export async function recoverJsonl(file, cursor = null, { maxReadBytes = 1024 * 1024, maxLineBytes = 64 * 1024, maxLines = 1000 } = {}) {
  const stat = await fs.stat(file);
  const rotated = cursor && (cursor.dev !== stat.dev || cursor.ino !== stat.ino || stat.size < cursor.offset);
  const start = cursor && !rotated ? cursor.offset : Math.max(0, stat.size - maxReadBytes);
  const length = Math.min(maxReadBytes, Math.max(0, stat.size - start));
  const handle = await fs.open(file, "r");
  let bytes;
  try { bytes = Buffer.alloc(length); await handle.read(bytes, 0, length, start); }
  finally { await handle.close(); }
  const prefix = cursor && !rotated ? cursor.partial ?? "" : "";
  const text = prefix + bytes.toString("utf8");
  const lines = text.split("\n");
  const partial = lines.pop() ?? "";
  const facts = [];
  let rejected = 0;
  for (const line of lines.slice(0, maxLines)) {
    if (Buffer.byteLength(line) > maxLineBytes) { rejected += 1; continue; }
    try { const fact = parseOpenClawRecord(JSON.parse(line)); if (fact) facts.push(fact); }
    catch { rejected += 1; }
  }
  return {
    facts,
    cursor: { dev: stat.dev, ino: stat.ino, offset: start + length, partial: partial.slice(0, maxLineBytes) },
    diagnostics: { rotated: Boolean(rotated), rejected, truncated: lines.length > maxLines },
  };
}
