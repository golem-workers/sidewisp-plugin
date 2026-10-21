import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { collectOpenClawUsage } from "../src/usage/openclaw.js";
import { collectHermesUsage } from "../src/usage/hermes.js";
import { createUsageDelivery } from "../src/delivery/usage.js";

function temporary(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("OpenClaw collector emits immutable content-free calls and separate shared quota", async () => {
  const fixture = temporary("sidewisp-openclaw-usage-");
  test.after(() => fixture.close());
  const directory = path.join(fixture.root, "agents", "main", "agent");
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "openclaw-agent.sqlite"));
  db.exec("CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,created_at INTEGER)");
  const insert = db.prepare("INSERT INTO transcript_events VALUES(?,?,?,?)");
  const event = (id, model, stopReason, input) => ({ type: "message", id,
    message: { role: "assistant", content: "must never leave the host", provider: "openai", model,
      stopReason, timestamp: 1_780_000_000_000, idempotencyKey: `secret:${id}`,
      __openclaw: { runId: "run-1", runTerminal: { status: stopReason } },
      usage: { input, output: 20, cacheRead: 30, cacheWrite: 4, reasoningTokens: 5,
        totalTokens: input + 54, cost: { total: 0 } } } });
  insert.run("session-1", 1, JSON.stringify(event("event-1", "gpt-a", "aborted", 10)), 1_780_000_000_000);
  insert.run("session-1", 2, JSON.stringify(event("event-2", "gpt-b", "completed", 11)), 1_780_000_001_000);
  db.close();
  const batch = await collectOpenClawUsage({ stateDir: fixture.root, collectedAtMs: 1_780_000_010_000,
    usageStatus: async () => ({ updatedAt: 1_780_000_009_000, providers: [{ provider: "openai",
      plan: "pro", accountEmail: "private@example.com", windows: [{ label: "168h", usedPercent: 80,
        resetAt: 1_780_100_000_000 }] }] }) });
  assert.equal(batch.observations.length, 2);
  assert.deepEqual(batch.observations.map((item) => item.runStatus).sort(), ["cancelled", "completed"]);
  assert.equal(batch.observations[0].reasoningTokens, 5);
  assert.ok([64, 65].includes(batch.observations[0].reportedTotalTokens));
  assert.equal(batch.observations[0].cost.status, "unknown");
  assert.equal(batch.observations[0].cost.billingMode, "subscription");
  assert.equal(batch.providerLimits[0].scope, "provider_account");
  assert.equal(batch.providerLimits[0].windows[0].remainingPercent, 20);
  assert.doesNotMatch(JSON.stringify(batch), /content|private@example|secret:event/);
  assert.equal(new Set(batch.observations.map((item) => item.sourceKey)).size, 2);
});

test("Hermes collector uses model attribution instead of double-counting session totals", async () => {
  const fixture = temporary("sidewisp-hermes-usage-");
  test.after(() => fixture.close());
  const db = new DatabaseSync(path.join(fixture.root, "state.db"));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,parent_session_id TEXT,started_at REAL,ended_at REAL,
    end_reason TEXT,last_activity_at REAL,pricing_version TEXT,input_tokens INTEGER,output_tokens INTEGER);
    CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,billing_base_url TEXT,
    billing_mode TEXT,task TEXT,api_call_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,
    cache_read_tokens INTEGER,cache_write_tokens INTEGER,reasoning_tokens INTEGER,estimated_cost_usd REAL,
    actual_cost_usd REAL,cost_status TEXT,cost_source TEXT,first_seen REAL,last_seen REAL);`);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run("child", "parent", 1780000000, 1780000100,
    "completed", 1780000100, "hermes-price-v1", 999, 999);
  db.prepare("INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("child", "model-a", "nous", "https://example.invalid", "api", "delegate", 2,
      100, 20, 30, 4, 5, 0.25, 0.20, "actual", "provider", 1780000000, 1780000100);
  db.close();
  const batch = await collectHermesUsage({ hermesHome: fixture.root, collectedAtMs: 1_780_000_200_000 });
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].inputTokens, 100);
  assert.equal(batch.observations[0].parentRunRef, "parent");
  assert.equal(batch.observations[0].task, "delegate");
  assert.equal(batch.observations[0].cost.status, "actual");
  assert.equal(batch.observations[0].cost.actualMicros, 200_000);
});

test("Hermes collector keeps absent pricing unknown instead of reporting zero", async () => {
  const fixture = temporary("sidewisp-hermes-unpriced-");
  test.after(() => fixture.close());
  const db = new DatabaseSync(path.join(fixture.root, "state.db"));
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,started_at REAL,input_tokens INTEGER,
    output_tokens INTEGER,estimated_cost_usd REAL DEFAULT 0,actual_cost_usd REAL DEFAULT 0,
    cost_status TEXT);`);
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)").run("session", 1780000000, 12, 3, 0, 0, null);
  db.close();
  const batch = await collectHermesUsage({ hermesHome: fixture.root, collectedAtMs: 1_780_000_200_000 });
  assert.equal(batch.observations.length, 1);
  assert.equal(batch.observations[0].cost.status, "unknown");
  assert.equal(batch.observations[0].cost.estimatedMicros, undefined);
});

test("usage delivery signs a coalesced batch and acknowledges only matching payload", async () => {
  let pending = null;
  const spool = {
    coalesceUsageBatch(installationId, batchId, batch) { pending = { installationId, batchId, batch }; },
    pendingUsageBatch() { return pending; },
    acknowledgeUsageBatch(installationId, batchId) {
      if (pending?.installationId !== installationId || pending?.batchId !== batchId) return false;
      pending = null; return true;
    },
  };
  let request;
  const delivery = createUsageDelivery({ collect: async ({ collectedAtMs }) => ({
    schema: "sidewisp.usage-batch.v1", collectedAtMs, observations: [], providerLimits: [],
  }), spool, endpoint: "https://sidewisp.test",
  credentialProvider: { current: async () => ({ status: "active", installationId: "agent-a", secret: "secret" }) },
  now: () => 1_780_000_000_000,
  fetchImpl: async (url, init) => { request = { url: String(url), init };
    return { ok: true, status: 200, json: async () => ({ schema: "sidewisp.usage-ack.v1", accepted: 0, providerLimits: 0 }) }; },
  });
  assert.equal((await delivery.runOnce()).status, "sent");
  assert.match(request.url, /\/v1\/usage\/batches$/);
  assert.match(request.init.headers.authorization, /^Sidewisp agent-a:/);
  assert.equal(pending, null);
});
