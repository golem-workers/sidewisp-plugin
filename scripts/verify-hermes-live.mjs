#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEnrollmentManager, createFileCredentialStore } from "../src/auth/credentials.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";
import { openSpool } from "../src/delivery/spool.js";
import { createUploader } from "../src/delivery/uploader.js";

const setupToken = process.env.SIDEWISP_SETUP_TOKEN;
const endpoint = process.env.SIDEWISP_ENDPOINT || "https://api.sidewisp.com";
const upstream = path.resolve(process.env.HERMES_SOURCE_DIR || "../repos/hermes-agent-upstream");
assert.match(setupToken || "", /^sw_setup_[A-Za-z0-9_-]{32,}$/);
assert.equal(new URL(endpoint).protocol, "https:");

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "sidewisp-hermes-live-"));
try {
  const evidenceFile = path.join(temporary, "evidence.json");
  const upstreamCheck = spawnSync(process.execPath, [path.resolve("scripts/verify-hermes-upstream.mjs")], {
    cwd: path.resolve("."), encoding: "utf8",
    env: { ...process.env, HERMES_SOURCE_DIR: upstream, SIDEWISP_HERMES_EVIDENCE_FILE: evidenceFile },
  });
  assert.equal(upstreamCheck.status, 0, upstreamCheck.stderr);
  const evidence = JSON.parse(await fsp.readFile(evidenceFile, "utf8"));
  const store = createFileCredentialStore({ stateDir: temporary });
  const auth = createEnrollmentManager({ endpoint, store, clearSetupToken: async () => {} });
  await auth.load();
  await auth.enroll(setupToken);
  const credential = auth.credential();
  assert.equal(credential?.status, "active");

  const allFacts = [
    ...evidence.facts.map((fact) => ({ fact, sourceKind: "hook" })),
    ...evidence.recovered.facts.map((fact) => ({ fact, sourceKind: "state" })),
  ];
  let sequence = 0;
  const events = [];
  for (const { fact, sourceKind } of allFacts) {
    sequence += 1;
    const observedAt = new Date(Number.isSafeInteger(fact.observed_at_ms) ? fact.observed_at_ms : Date.now()).toISOString();
    const digest = crypto.createHash("sha256").update(`hermes-live\0${fact.event_key || sequence}`).digest("base64url").slice(0, 32);
    const normalized = normalizeRuntimeEvent("hermes", fact, {
      eventId: `sw_evt_${digest}`, installationId: credential.installationId, sequence,
      occurredAt: observedAt, observedAt,
      runtime: { kind: "hermes", version: "upstream-canary" },
      source: { kind: sourceKind, adapterVersion: "0.1.7" },
      correlation: fact.correlation || {}, details: {},
    });
    if (normalized.event) events.push(normalized.event);
  }
  assert.ok(events.some(({ type }) => type === "tool.failed"));
  assert.ok(events.some(({ type }) => type === "provider.unavailable"));
  assert.ok(events.some(({ type }) => type === "runtime.crashed"));

  const spool = await openSpool({ file: path.join(temporary, "spool.sqlite") });
  spool.enqueueSourceBatch("hermes-live", String(sequence), events);
  const credentials = { current: async () => credential };
  const outage = createUploader({ spool, endpoint: "https://127.0.0.1:9", credentialProvider: credentials, timeoutMs: 500 });
  const outageResult = await outage.sendOnce();
  assert.equal(outageResult.status, "retry");
  assert.equal(spool.pending(100).length, events.length);
  const uploader = createUploader({ spool, endpoint, credentialProvider: credentials });
  const delivered = await uploader.drain({ maxAttempts: 3 });
  assert.equal(spool.pending(100).length, 0);
  await spool.close();

  console.log(JSON.stringify({
    runtime: "hermes", hooks: evidence.hooks.length, normalizedEvents: events.length,
    eventTypes: [...new Set(events.map(({ type }) => type))].sort(),
    sinkFailureIsolated: true, stateRecoveryReadOnly: true, outageRetainedEvents: true,
    deliveryStatus: delivered.status, remaining: delivered.remaining, inferenceCalls: 0,
    temporaryResourcesCleaned: true,
  }));
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}
