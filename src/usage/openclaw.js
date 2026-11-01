import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { USAGE_PARSER_VERSION, USAGE_SCHEMA, epochMs, nonNegative, safeId, safeText, usageCost } from "./common.js";

const execFile = promisify(execFileCallback);

async function agentDatabases(stateDir) {
  const root = path.join(stateDir, "agents");
  const agents = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  return agents.filter((entry) => entry.isDirectory()).map((entry) => ({
    agentId: entry.name,
    file: path.join(root, entry.name, "agent", "openclaw-agent.sqlite"),
  })).filter(({ file }) => fs.existsSync(file));
}

function runStatus(message) {
  const terminal = message?.__openclaw?.runTerminal;
  const value = terminal?.status ?? terminal?.outcome ?? message?.stopReason;
  if (["cancelled", "aborted"].includes(value)) return "cancelled";
  if (["error", "failed"].includes(value)) return "failed";
  if (["stop", "completed", "success"].includes(value)) return "completed";
  return terminal ? "completed" : "unknown";
}

function observation(row, event, agentId, collectedAtMs, subscriptionProviders) {
  const message = event?.message;
  const usage = message?.usage;
  if (message?.role !== "assistant" || !usage || typeof usage !== "object") return null;
  const inputTokens = nonNegative(usage.input);
  const outputTokens = nonNegative(usage.output);
  const cacheReadTokens = nonNegative(usage.cacheRead);
  const cacheWriteTokens = nonNegative(usage.cacheWrite);
  const reasoningTokens = nonNegative(usage.reasoningTokens);
  const reportedTotalTokens = nonNegative(usage.totalTokens,
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
  if (reportedTotalTokens === 0) return null;
  const provider = safeText(message.provider);
  const modelName = safeText(message.model);
  const recorded = Number(usage.cost?.total);
  const explicit = usage.costStatus ?? usage.cost?.status;
  const billingMode = subscriptionProviders.has(provider) ? "subscription" : "api";
  const cost = explicit === "actual" && recorded >= 0
    ? usageCost({ actual: recorded, status: "actual", source: usage.costSource ?? "openclaw_recorded", billingMode })
    : recorded > 0
      ? usageCost({ estimated: recorded, status: "estimated", source: "openclaw_session_estimate", billingMode })
      : usageCost({ billingMode });
  const runRef = safeText(message.__openclaw?.runId ?? row.sessionId);
  return {
    sourceKey: safeId(["openclaw", agentId, row.sessionId, String(row.seq), String(event.id ?? message.idempotencyKey ?? "")]),
    sourceRevision: Math.max(1, epochMs(row.createdAt, collectedAtMs)),
    runRef,
    runtime: "openclaw",
    provider,
    model: `${provider}:${modelName}`,
    task: safeText(agentId),
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, reportedTotalTokens,
    cost,
    quality: "exact",
    completeness: "complete",
    sourceCollector: "openclaw-session-store",
    parserVersion: USAGE_PARSER_VERSION,
    progressEvidence: outputTokens > 0,
    runStatus: runStatus(message),
    occurredAtMs: epochMs(message.timestamp ?? event.timestamp ?? row.createdAt, collectedAtMs),
  };
}

async function defaultUsageStatus() {
  const { stdout } = await execFile("openclaw", ["gateway", "call", "usage.status", "--json"], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function limitsFromStatus(status, collectedAtMs) {
  const providers = Array.isArray(status?.providers) ? status.providers : [];
  return providers.filter((entry) => typeof entry?.provider === "string" && !entry.error).map((entry) => ({
    provider: safeText(entry.provider),
    scope: "provider_account",
    ...(typeof entry.plan === "string" ? { plan: safeText(entry.plan) } : {}),
    windows: (Array.isArray(entry.windows) ? entry.windows : []).slice(0, 8).map((window) => ({
      label: safeText(window.label, "window", 40),
      ...(Number.isFinite(Number(window.usedPercent)) ? { usedPercent: Number(window.usedPercent) } : {}),
      ...(Number.isFinite(Number(window.usedPercent)) ? { remainingPercent: Math.max(0, 100 - Number(window.usedPercent)) } : {}),
      ...(Number.isFinite(Number(window.resetAt)) ? { resetAtMs: Math.round(Number(window.resetAt)) } : {}),
    })),
    currency: "USD",
    observedAtMs: epochMs(status.updatedAt, collectedAtMs),
    source: "openclaw-usage-status",
  }));
}

export async function collectOpenClawUsage({ stateDir, collectedAtMs = Date.now(),
  usageStatus = defaultUsageStatus, lookbackDays = 35, maxObservations = 10_000 } = {}) {
  let status = null;
  try { status = await usageStatus(); } catch { status = null; }
  const providerLimits = limitsFromStatus(status, collectedAtMs);
  const subscriptionProviders = new Set(providerLimits.filter((entry) => entry.plan).map((entry) => entry.provider));
  const cutoff = collectedAtMs - lookbackDays * 86_400_000;
  const observations = [];
  let truncated = false;
  for (const { agentId, file } of await agentDatabases(stateDir)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT session_id AS sessionId,seq,event_json AS eventJson,created_at AS createdAt
        FROM transcript_events WHERE created_at>=? ORDER BY created_at DESC LIMIT ?`).all(cutoff, maxObservations + 1);
      for (const row of rows) {
        if (observations.length >= maxObservations) { truncated = true; break; }
        let event;
        try { event = JSON.parse(row.eventJson); } catch { continue; }
        const item = observation(row, event, agentId, collectedAtMs, subscriptionProviders);
        if (item) observations.push(item);
      }
    } finally { db.close(); }
    if (truncated) break;
  }
  if (truncated) observations.forEach((item) => { item.completeness = "partial"; });
  return { schema: USAGE_SCHEMA, collectedAtMs, observations, providerLimits };
}
