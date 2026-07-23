#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createHermesAdapter } from "../src/adapters/hermes/index.js";
import { createEnrollmentManager, createFileCredentialStore } from "../src/auth/credentials.js";
import { sanitizeTelemetryEvent } from "../src/core/sanitize.js";
import { openSpool } from "../src/delivery/spool.js";
import { createUploader } from "../src/delivery/uploader.js";

const endpoint = new URL(process.env.SIDEWISP_ENDPOINT || "https://api.sidewisp.com");
const stateDir = path.resolve(process.env.SIDEWISP_STATE_DIR || "/var/lib/sidewisp-hermes-canary");
const upstream = path.resolve(process.env.HERMES_SOURCE_DIR || "../repos/hermes-agent-upstream");
const setupToken = process.env.SIDEWISP_SETUP_TOKEN || "";
const intervalMs = Number(process.env.SIDEWISP_HEARTBEAT_INTERVAL_MS || 30_000);

assert.equal(endpoint.protocol, "https:");
assert.ok(Number.isSafeInteger(intervalMs) && intervalMs >= 10_000 && intervalMs <= 300_000);
await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
await fsp.chmod(stateDir, 0o700);

const compatibilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sidewisp-hermes-compat-"));
try {
  const evidenceFile = path.join(compatibilityDir, "evidence.json");
  const result = spawnSync(process.execPath, [path.resolve("scripts/verify-hermes-upstream.mjs")], {
    cwd: path.resolve("."), encoding: "utf8",
    env: { ...process.env, HERMES_SOURCE_DIR: upstream, SIDEWISP_HERMES_EVIDENCE_FILE: evidenceFile },
  });
  assert.equal(result.status, 0, result.stderr || "Hermes compatibility check failed");
  const evidence = JSON.parse(await fsp.readFile(evidenceFile, "utf8"));
  assert.ok(evidence.hooks.length > 0);
} finally {
  await fsp.rm(compatibilityDir, { recursive: true, force: true });
}

const store = createFileCredentialStore({ stateDir });
const auth = createEnrollmentManager({ endpoint, store, clearSetupToken: async () => {} });
await auth.load();
if (!auth.canSend()) {
  assert.match(setupToken, /^sw_setup_[A-Za-z0-9_-]{32,}$/);
  await auth.enroll(setupToken);
}
const credential = auth.credential();
assert.equal(credential?.status, "active");

const adapter = createHermesAdapter({
  version: process.env.HERMES_RUNTIME_VERSION || "upstream-canary",
  probes: {
    process: async () => ({ status: fs.existsSync(upstream) ? "healthy" : "unhealthy", reason: fs.existsSync(upstream) ? "runtime-present" : "runtime-missing" }),
    collector: async () => ({ status: "healthy" }),
    queue: async () => ({ status: "healthy" }),
    spool: async () => ({ status: "healthy" }),
  },
});
const spool = await openSpool({ file: path.join(stateDir, "spool.sqlite") });
const uploader = createUploader({ spool, endpoint, credentialProvider: { current: async () => credential } });
let sequence = 0;
let stopped = false;

async function heartbeat() {
  const snapshot = await adapter.healthSnapshot();
  const observedAt = snapshot.observedAt;
  sequence += 1;
  const event = sanitizeTelemetryEvent({
    schema: "sidewisp.telemetry.v1",
    eventId: `sw_evt_${crypto.createHash("sha256").update(`hermes-health\0${credential.installationId}\0${observedAt}`).digest("base64url").slice(0, 32)}`,
    installationId: credential.installationId,
    sequence,
    occurredAt: observedAt,
    observedAt,
    runtime: { kind: "hermes", version: process.env.HERMES_RUNTIME_VERSION || "upstream-canary", instanceId: os.hostname() },
    source: { kind: "health", adapterVersion: "0.1.0" },
    type: "health.snapshot",
    outcome: snapshot.overall === "healthy" ? "success" : "degraded",
    correlation: {},
    details: { status: snapshot.overall },
  });
  spool.enqueueSourceBatch("hermes-health", String(sequence), [event]);
  const delivered = await uploader.drain({ maxAttempts: 3 });
  if (delivered.remaining !== 0) throw new Error("Hermes canary heartbeat delivery remains queued");
}

async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  await spool.close();
}

process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));
process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
await heartbeat();
const timer = setInterval(() => heartbeat().catch((error) => {
  process.stderr.write(`Hermes canary heartbeat failed: ${error.message}\n`);
}), intervalMs);
await new Promise((resolve) => {
  process.once("SIGTERM", resolve);
  process.once("SIGINT", resolve);
});
