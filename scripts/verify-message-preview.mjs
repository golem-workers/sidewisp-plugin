// Isolated real HTTP proof; never targets a deployed environment.
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
const plugin = resolve(process.env.SIDEWISP_PLUGIN_DIR ?? fileURLToPath(new URL("..", import.meta.url)));
const backend = resolve(process.env.SIDEWISP_BACKEND_DIR ?? "../sidewisp-backend");
const { createFileCredentialStore, createEnrollmentManager } = await import(`${plugin}/src/auth/credentials.js`);
const { createUploader } = await import(`${plugin}/src/delivery/uploader.js`);
const { createCronDelivery } = await import(`${plugin}/src/delivery/cron.js`);
const { openSpool } = await import(`${plugin}/src/delivery/spool.js`);
const { registerOpenClawHooks, createOpenClawUserTaskLifecycle } = await import(`${plugin}/src/adapters/openclaw/hooks.js`);
const { normalizeRuntimeEvent } = await import(`${plugin}/src/core/normalize.js`);
const { SidewispDatabase } = await import(`${backend}/src/storage/database.mjs`);
const { InstallationService } = await import(`${backend}/src/auth/installations.mjs`);
const { createInstallationMutationGrantAuthority } = await import(`${backend}/src/auth/installation-mutation-grants.mjs`);
const { MonitoringApi } = await import(`${backend}/src/api/monitoring.mjs`);
const { IncidentEngine } = await import(`${backend}/src/incidents/engine.mjs`);
const { verifySignedRequest } = await import(`${backend}/src/auth/requests.mjs`);
const { createSidewispHttpServer } = await import(`${backend}/src/http/server.mjs`);
const root = await mkdtemp(join(tmpdir(), "sidewisp-preview-e2e-"));
const db = new SidewispDatabase(join(root, "backend.sqlite"));
const tenantId = "tenant_preview_contract";
db.createTenant({ id: tenantId });
db.createUser({ id: "operator", identitySubject: "internal-admin|preview-e2e" });
db.setTenantMembership({ tenantId, userId: "operator", role: "admin" });
const grants = createInstallationMutationGrantAuthority();
const installations = new InstallationService({ db, masterKey: randomBytes(32), ingestionUrl: "http://localhost/v1/telemetry/batches", mutationGrantVerifier: grants.verifier });
const operator = { tenantId, userId: "operator", role: "admin", authType: "internal_admin", authenticatedAtMs: Date.now() };
const app = createSidewispHttpServer({ db, installations, incidentEngine: new IncidentEngine({ db }),
  monitoring: new MonitoringApi({ db, installations, installationMutationGrantIssuer: grants.issuer }),
  authenticateIngest: ({ headers, body }) => verifySignedRequest({ db, installationService: installations, headers, body }),
  authorizeUser: async () => operator });
let spool, cron;
try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const endpoint = `http://127.0.0.1:${address.port}`;
  const createdResponse = await fetch(`${endpoint}/v1/installations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtime: "openclaw", displayName: "Preview isolated fixture" }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const manager = createEnrollmentManager({ endpoint, store: createFileCredentialStore({ stateDir: root }) });
  await manager.enroll(created.setupToken);
  const initialCredential = structuredClone(manager.credential());
  const credentialProvider = { current: async () => manager.credential() };
  const job = { id: "native_fixture_job", displayName: "Daily check", enabled: true, kind: "cron", expression: "0 9 * * *", timezone: "UTC", payloadKind: "agentTurn",
    createdAtMs: Date.now() - 10000, nextRunAtMs: Date.now() + 60000, lastRunAtMs: null, lastStatus: "unknown" };
  cron = createCronDelivery({ endpoint, credentialProvider, collect: async () => ({ status: "ok", jobs: [job] }) });
  assert.equal((await cron.run()).status, "sent");
  const cronBefore = await (await fetch(`${endpoint}/v1/installations/${created.installationId}/cron-jobs`)).json();
  assert.equal(cronBefore.items.length, 1);
  spool = await openSpool({ file: join(root, "plugin-spool.sqlite") });
  let sequence = 0;
  const envelopeFactory = () => ({ eventId: `sw_evt_previewcontract${String(++sequence).padStart(8, "0")}`, installationId: created.installationId, sequence,
    occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), runtime: { version: "2026.9.1" }, source: { kind: "hook", adapterVersion: "0.2.57" } });
  const lifecycle = createOpenClawUserTaskLifecycle();
  const persist = input => {
    const result = lifecycle.processDetailed(input);
    if (result.event) {
      spool.enqueueSourceBatch("hook", String(result.event.sequence), [result.event]);
      lifecycle.commit(result.event);
    }
    return result;
  };
  const hooks = new Map();
  registerOpenClawHooks({ on: (name, handler) => hooks.set(name, handler) }, { envelopeFactory, emit: persist });
  const rawFinal = "Проверка готова. ".repeat(30) + "Suffix not sent";
  const runTask = (messageId, text, route) => {
    const ctx = { sessionKey: "agent:main:telegram:group:fixture", runId: `run_${messageId}` };
    hooks.get("message_received")({ messageId, content: "PRIVATE_USER_PROMPT" }, ctx);
    hooks.get("before_dispatch")({ messageId }, ctx);
    const start = normalizeRuntimeEvent("openclaw", { kind: "turn_start", correlation: { sessionId: ctx.sessionKey, turnId: ctx.runId } }, envelopeFactory()).event;
    assert.ok(start); persist(start);
    const params = { action: "send", final: false, message: "Проверяю совместимость" };
    hooks.get("after_tool_call")({ toolName: "message", params, result: { details: { ok: true, sourceReplyRoute: "current-source" } } }, ctx);
    if (route === "tool") {
      hooks.get("after_tool_call")({ toolName: "message", params: { ...params, final: true, message: text }, result: { details: { ok: true, sourceReplyRoute: "current-source" } } }, ctx);
    } else {
      let before;
      hooks.get("reply_dispatch")({}, { ...ctx, dispatcher: { appendBeforeDeliver: callback => { before = callback; } } });
      const payload = Object.freeze({ text });
      assert.equal(before(payload, { kind: "final" }), payload);
    }
  };
  runTask("safe", rawFinal, "reply");
  runTask("none", undefined, "reply");
  runTask("unsafe", "Проверка готова. ".repeat(30) + "password=DO_NOT_SEND_THIS", "tool");
  hooks.get("message_sent")({ content: "Готово", success: true, messageId: "outbound" }, { sessionKey: "agent:main:telegram:group:fixture" });
  await new Promise(resolve => setImmediate(resolve));
  const pending = spool.pending(100).map(item => item.event);
  const wire = JSON.stringify(pending);
  for (const forbidden of [rawFinal, "Suffix not sent", "DO_NOT_SEND_THIS", "PRIVATE_USER_PROMPT", "password="]) assert.equal(wire.includes(forbidden), false);
  const terminal = pending.filter(event => event.type === "turn.completed");
  assert.equal(terminal.length, 3);
  assert.ok(terminal[0].messagePreview.length <= 160);
  assert.equal("messagePreview" in terminal[1], false);
  assert.equal("messagePreview" in terminal[2], false);
  assert.equal(lifecycle.activeWork().length, 0);
  // Force a real spool close/reopen to prove only the safe excerpt persists.
  await spool.close(); spool = await openSpool({ file: join(root, "plugin-spool.sqlite") });
  const uploader = createUploader({ spool, endpoint, credentialProvider, compressThresholdBytes: 1 });
  assert.equal((await uploader.drain()).status, "idle");
  assert.equal(spool.pending().length, 0);
  assert.deepEqual(manager.credential(), initialCredential);
  const activityResponse = await fetch(`${endpoint}/v1/activity?workOnly=true&limit=100`);
  assert.equal(activityResponse.status, 200);
  const page = await activityResponse.json();
  assert.equal(page.items.length, 9);
  assert.deepEqual(page.items.map(item => item.workTransition).sort(), [...Array(3).fill("started"), ...Array(3).fill("progress"), ...Array(3).fill("completed")].sort());
  const previews = page.items.filter(item => Object.hasOwn(item, "messagePreview"));
  assert.equal(previews.length, 4);
  assert.equal(page.items.filter(item => item.workTransition === "completed" && !Object.hasOwn(item, "messagePreview")).length, 2);
  for (const item of previews) assert.ok(item.messagePreview.length <= 160 && !/[\r\n]/.test(item.messagePreview));
  for (const turn of ["safe", "none", "unsafe"]) {
    const matching = pending.filter(event => event.correlation.turnId === turn && event.type.startsWith("turn."));
    assert.equal(matching.length, 3);
  }
  const cronAfter = await (await fetch(`${endpoint}/v1/installations/${created.installationId}/cron-jobs`)).json();
  assert.deepEqual(cronAfter.items, cronBefore.items);
  const detail = await (await fetch(`${endpoint}/v1/installations/${created.installationId}`)).json();
  assert.equal(detail.id ?? detail.installationId, created.installationId);
  let legacyCompatibility = "not requested";
  if (process.env.SIDEWISP_LEGACY_APP_DIR) {
    const appDir = resolve(process.env.SIDEWISP_LEGACY_APP_DIR);
    const legacy = await import(`${appDir}/src/activity/agentWorkState.mjs`);
    const without = page.items.map(({ messagePreview, ...item }) => item);
    assert.deepEqual(legacy.recentAgentWorkTransitions(page.items), legacy.recentAgentWorkTransitions(without));
    assert.deepEqual(legacy.latestAgentWorkStates(page.items), legacy.latestAgentWorkStates(without));
    legacyCompatibility = "same work projection with and without preview";
  }
  const policyA = await readFile(`${plugin}/src/core/message-preview.js`, "utf8");
  const policyB = await readFile(`${backend}/src/security/message-preview.mjs`, "utf8");
  assert.equal(policyA, policyB, "plugin/API privacy policies drifted");
  process.stdout.write(JSON.stringify({ ok: true, pluginVersion: JSON.parse(await readFile(`${plugin}/package.json`, "utf8")).version,
    transport: "signed gzip HTTP", spool: "SQLite reopen", workEvents: page.items.length, previews: previews.length,
    safeMissingAndUnsafe: "verified", binding: "preserved", cron: "unchanged", legacyCompatibility }) + "\n");
} finally {
  await cron?.stop(); await spool?.close(); await app.close(); db.close(); await rm(root, { recursive: true, force: true });
}
