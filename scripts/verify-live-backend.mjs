import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileCredentialStore, createEnrollmentManager } from "../src/auth/credentials.js";
import { createUploader } from "../src/delivery/uploader.js";

const endpoint = process.env.SIDEWISP_LIVE_ENDPOINT; const setupToken = process.env.SIDEWISP_LIVE_SETUP_TOKEN;
if (!endpoint?.startsWith("https://") || !setupToken?.startsWith("sw_setup_")) throw new Error("HTTPS endpoint and setup token are required");
const root = await mkdtemp(join(tmpdir(), "sidewisp-live-"));
try {
  const manager = createEnrollmentManager({ endpoint, store: createFileCredentialStore({ stateDir: root }) }); await manager.enroll(setupToken); const credential = manager.credential();
  const base = { schema: "sidewisp.telemetry.v1", installationId: credential.installationId,
    occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), runtime: { kind: "openclaw", version: "2026.7.1", instanceId: "staging-canary" },
    source: { kind: "hook", adapterVersion: "0.1.8" } };
  const eventSeed = Date.now();
  const events = [
    { ...base, eventId: `sw_evt_livehealth${eventSeed}`, sequence: 1, type: "health.snapshot", outcome: "success", correlation: {}, details: { status: "healthy" } },
    { ...base, eventId: `sw_evt_livefailure${eventSeed}`, sequence: 2, type: "tool.failed", outcome: "failure", correlation: { toolCallId: "live-check" }, details: { code: "TOOL_FAILED", component: "tool", operation: "exec", recoverable: true, expected: false } },
  ];
  const pending = [...events]; const spool = { pending: () => pending.map(item => ({ eventId: item.eventId, event: item })),
    acknowledge: ids => ids.forEach(id => { const index = pending.findIndex(item => item.eventId === id); if (index >= 0) pending.splice(index, 1); }), deadLetter(id) { this.acknowledge([id]); } };
  const uploader = createUploader({ spool, endpoint, compressThresholdBytes: 1, credentialProvider: { current: async () => manager.credential() } }); const result = await uploader.drain();
  if (result.status !== "idle" || pending.length) throw new Error(`live delivery failed: ${result.status}`);
  process.stdout.write(JSON.stringify({ ok: true, installationId: credential.installationId, eventIds: events.map(event => event.eventId), eventTypes: events.map(event => event.type), delivery: "acknowledged" }) + "\n");
} finally { await rm(root, { recursive: true, force: true }); }
