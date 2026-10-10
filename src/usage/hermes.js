import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { USAGE_PARSER_VERSION, USAGE_SCHEMA, epochMs, nonNegative, safeId, safeText, usageCost } from "./common.js";

async function stateDatabases(home) {
  const candidates = new Set([path.join(home, "state.db")]);
  const entries = await fsp.readdir(home, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    candidates.add(path.join(home, entry.name, "state.db"));
  }
  return [...candidates].filter((file) => fs.existsSync(file));
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function selectColumn(available, name, fallback = "NULL") {
  return available.has(name) ? name : `${fallback} AS ${name}`;
}

function hermesObservation(row, profile, collectedAtMs) {
  const provider = safeText(row.billing_provider);
  const model = safeText(row.model);
  const actual = Number(row.actual_cost_usd);
  const estimated = Number(row.estimated_cost_usd);
  const status = row.cost_status === "actual" && Number.isFinite(actual) ? "actual"
    : row.cost_status === "estimated" && Number.isFinite(estimated) ? "estimated" : "unknown";
  const billingMode = ["api", "subscription"].includes(row.billing_mode) ? row.billing_mode : "unknown";
  const lastSeen = epochMs(row.last_seen ?? row.ended_at ?? row.last_activity_at ?? row.started_at, collectedAtMs);
  return {
    sourceKey: safeId(["hermes", profile, row.session_id, model, provider,
      String(row.billing_base_url ?? ""), String(row.billing_mode ?? ""), String(row.task ?? "")]),
    sourceRevision: Math.max(1, lastSeen),
    runRef: safeText(row.session_id),
    ...(row.parent_session_id ? { parentRunRef: safeText(row.parent_session_id) } : {}),
    runtime: "hermes", provider, model: `${provider}:${model}`,
    ...(row.task ? { task: safeText(row.task) } : { task: "session" }),
    inputTokens: nonNegative(row.input_tokens), outputTokens: nonNegative(row.output_tokens),
    cacheReadTokens: nonNegative(row.cache_read_tokens), cacheWriteTokens: nonNegative(row.cache_write_tokens),
    reasoningTokens: nonNegative(row.reasoning_tokens),
    cost: status === "actual"
      ? usageCost({ actual, status, source: row.cost_source ?? "hermes_recorded", billingMode })
      : status === "estimated"
        ? usageCost({ estimated, status, source: row.cost_source ?? "hermes_estimate",
            pricingVersion: row.pricing_version, billingMode })
        : usageCost({ billingMode }),
    quality: "exact", completeness: "complete", sourceCollector: "hermes-state-db",
    parserVersion: USAGE_PARSER_VERSION,
    progressEvidence: nonNegative(row.output_tokens) > 0,
    runStatus: row.ended_at ? (row.end_reason === "cancelled" ? "cancelled"
      : row.end_reason === "error" ? "failed" : "completed") : "running",
    occurredAtMs: lastSeen,
  };
}

export async function collectHermesUsage({ hermesHome = process.env.HERMES_HOME
  || path.join(os.homedir(), ".hermes"), collectedAtMs = Date.now(), maxObservations = 10_000 } = {}) {
  const observations = [];
  let truncated = false;
  for (const file of await stateDatabases(hermesHome)) {
    const profile = safeText(path.basename(path.dirname(file)), "default");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      if (!tables.has("sessions")) continue;
      const sessionColumns = columns(db, "sessions");
      const modelColumns = tables.has("session_model_usage") ? columns(db, "session_model_usage") : new Set();
      const fields = ["session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task",
        "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
        "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source",
        "first_seen", "last_seen"];
      let rows;
      if (modelColumns.has("session_id")) {
        const selected = fields.map((name) => selectColumn(modelColumns, name, name === "task" ? "''" : "NULL"));
        rows = db.prepare(`SELECT ${selected.join(",")} FROM session_model_usage LIMIT ?`).all(maxObservations + 1);
      } else {
        const names = ["id AS session_id", "model", "billing_provider", "billing_base_url", "billing_mode",
          "api_call_count", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
          "reasoning_tokens", "estimated_cost_usd", "actual_cost_usd", "cost_status", "cost_source",
          "pricing_version", "started_at", "ended_at", "end_reason", "parent_session_id", "last_activity_at"];
        rows = db.prepare(`SELECT ${names.map((field) => {
          const name = field.split(" ")[0];
          return selectColumn(sessionColumns, name, name === "id" ? "''" : "NULL").replace(name, field);
        }).join(",")} FROM sessions LIMIT ?`).all(maxObservations + 1);
      }
      const parentFields = ["id", "parent_session_id", "started_at", "ended_at", "end_reason",
        "last_activity_at", "pricing_version"];
      const parents = new Map(db.prepare(`SELECT ${parentFields.map((name) =>
        selectColumn(sessionColumns, name)).join(",")} FROM sessions`).all().map((row) => [row.id, row]));
      for (const row of rows) {
        if (observations.length >= maxObservations) { truncated = true; break; }
        observations.push(hermesObservation({ ...parents.get(row.session_id), ...row }, profile, collectedAtMs));
      }
    } finally { db.close(); }
    if (truncated) break;
  }
  if (truncated) observations.forEach((item) => { item.completeness = "partial"; });
  return { schema: USAGE_SCHEMA, collectedAtMs, observations, providerLimits: [] };
}
