import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createFileCredentialStore, createEnrollmentManager } from "../src/auth/credentials.js";
import { createUploader } from "../src/delivery/uploader.js";

const backend = resolve(process.env.SIDEWISP_BACKEND_DIR ?? "../sidewisp-backend");
const { SidewispDatabase } = await import(`${backend}/src/storage/database.mjs`);
const { InstallationService } = await import(`${backend}/src/auth/installations.mjs`);
const { MonitoringApi } = await import(`${backend}/src/api/monitoring.mjs`);
const { IncidentEngine } = await import(`${backend}/src/incidents/engine.mjs`);
const { verifySignedRequest } = await import(`${backend}/src/auth/requests.mjs`);
const { createSidewispHttpServer } = await import(`${backend}/src/http/server.mjs`);

const root = await mkdtemp(join(tmpdir(), "sidewisp-plugin-backend-"));
const db = new SidewispDatabase(); db.createTenant({ id: "tenant_contract" });
const installations = new InstallationService({ db, masterKey: randomBytes(32), ingestionUrl: "http://localhost/v1/telemetry/batches" });
const incidents = new IncidentEngine({ db });
const app = createSidewispHttpServer({ db, installations, monitoring: new MonitoringApi({ db, installations }), incidentEngine: incidents,
  authenticateIngest: ({ headers, body }) => verifySignedRequest({ db, installationService: installations, headers, body }),
  authorizeUser: async () => ({ tenantId: "tenant_contract", role: "admin" }) });
try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 }); const endpoint = `http://127.0.0.1:${address.port}`;
  const created = await (await fetch(`${endpoint}/v1/installations`, { method: "POST", body: JSON.stringify({ runtime: "openclaw", displayName: "plugin-contract" }) })).json();
  const manager = createEnrollmentManager({ endpoint, store: createFileCredentialStore({ stateDir: root }) }); await manager.enroll(created.setupToken);
  const event = { schema: "sidewisp.telemetry.v1", eventId: "sw_evt_plugincontract000001", installationId: created.installationId, sequence: 1,
    occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), runtime: { kind: "openclaw", version: "2026.7.1", instanceId: "contract" },
    source: { kind: "hook", adapterVersion: "0.1.0" }, type: "tool.failed", outcome: "failure", correlation: { toolCallId: "call-1" },
    details: { code: "TOOL_FAILED", component: "tool", operation: "exec", recoverable: true, expected: false } };
  const pending = [event];
  const spool = { pending: (limit) => pending.slice(0, limit).map((item) => ({ eventId: item.eventId, event: item })),
    acknowledge: (ids) => ids.forEach((id) => { const index = pending.findIndex((item) => item.eventId === id); if (index >= 0) pending.splice(index, 1); }),
    deadLetter(id) { this.acknowledge([id]); } };
  const uploader = createUploader({ spool, endpoint, compressThresholdBytes: 1, credentialProvider: { current: async () => manager.credential() } });
  const result = await uploader.drain(); if (result.status !== "idle" || pending.length !== 0) throw new Error(`delivery failed: ${JSON.stringify(result)}`);
  const listed = await (await fetch(`${endpoint}/v1/incidents`)).json();
  if (listed.items[0]?.ruleId !== "tool-failure") throw new Error("incident was not created");
  const previousSecret = manager.credential().secret;
  const rotation = await (await fetch(`${endpoint}/v1/installations/${created.installationId}/rotate`, { method: "POST" })).json();
  if (rotation.installationSecret || !rotation.setupToken) throw new Error("unsafe rotation response");
  await manager.enroll(rotation.setupToken);
  if (manager.credential().secret === previousSecret) throw new Error("plugin did not apply rotated credential");
  const detail = await (await fetch(`${endpoint}/v1/installations/${created.installationId}`)).json();
  if (detail.credentialTransition?.status !== "applied") throw new Error("rotation was not acknowledged");
  process.stdout.write(JSON.stringify({ ok: true, installationId: created.installationId, incidentRule: listed.items[0].ruleId, rotation: "applied" }) + "\n");
} finally { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); }
