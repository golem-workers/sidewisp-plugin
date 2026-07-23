import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import crypto from "node:crypto";
import path from "node:path";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { readSetupToken, resolveConfig } from "../../../config.js";
import { createEnrollmentManager, createFileCredentialStore } from "../../auth/credentials.js";
import { createCollector } from "../../core/collector.js";
import { normalizeRuntimeEvent } from "../../core/normalize.js";
import { sanitizeTelemetryEvent } from "../../core/sanitize.js";
import { createAdapterRegistry } from "../../core/runtime-adapter.js";
import { createSafeSupportBundle } from "../../core/support.js";
import { openSpool } from "../../delivery/spool.js";
import { createUploader } from "../../delivery/uploader.js";
import { createOpenClawAdapter } from "./index.js";
import { registerOpenClawHooks } from "./hooks.js";
import { discoverOpenClawSources, recoverJsonl, stableOpenClawEventId } from "./recovery.js";
import { createUpdateScheduler } from "../../update/scheduler.js";

const VERSION = "0.1.9";

export default definePluginEntry({
  id: "sidewisp",
  name: "Sidewisp",
  description: "Zero-LLM runtime health and failure telemetry",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const setupToken = readSetupToken(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    const updates = createUpdateScheduler({ stateDir, logger: api.logger, currentVersion: VERSION });
    const auth = createEnrollmentManager({
      endpoint: config.endpoint,
      store: createFileCredentialStore({ stateDir }),
      clearSetupToken: async () => mutateConfigFile({ mutate(draft) {
        const entry = draft.plugins?.entries?.sidewisp;
        if (entry?.config && typeof entry.config === "object") delete entry.config.setupToken;
      } }),
    });
    let spool = null;
    const healthy = async () => ({ status: "healthy" });
    const registry = createAdapterRegistry([createOpenClawAdapter({
      logger: api.logger,
      version: api.runtime.version,
      probes: {
        process: healthy,
        gateway: healthy,
        config: async () => auth.canSend() ? { status: "healthy" } : { status: "degraded", reason: "awaiting-setup" },
        collector: async () => spool ? { status: "healthy" } : { status: "degraded", reason: "starting" },
        queue: healthy,
        spool: async () => {
          const status = spool?.health().status;
          return status === "healthy" ? { status } : { status: status === "unhealthy" ? "unhealthy" : "degraded", reason: status ?? "starting" };
        },
      },
    })]);
    const adapter = registry.select("openclaw");
    const collector = createCollector({ adapter });
    let sequence = 0;
    let uploader = null;
    let uploadTimer = null;
    let healthTimer = null;
    const preStartEvents = [];
    const persistEvent = async (event) => {
      if (!spool) {
        if (preStartEvents.length < 1000) preStartEvents.push(event);
        return;
      }
      spool.enqueueSourceBatch("openclaw-hooks", String(event.sequence), [event]);
    };
    const makeEnvelope = (input, sourceKind = "hook", fallback = "") => {
      const now = new Date().toISOString();
      sequence += 1;
      return {
        eventId: stableOpenClawEventId(input, fallback || `${sequence}|${crypto.randomUUID()}`),
        installationId: auth.status().installationId ?? "sw_ins_unconfigured",
        sequence, occurredAt: now, observedAt: now,
        runtime: { version: api.runtime.version }, source: { kind: sourceKind, adapterVersion: VERSION },
      };
    };
    const emitHeartbeat = async () => {
      if (!spool || !auth.canSend()) return;
      const snapshot = await adapter.healthSnapshot();
      const envelope = makeEnvelope({}, "health", `health|${Date.now()}|${crypto.randomUUID()}`);
      await persistEvent(sanitizeTelemetryEvent({
        ...envelope,
        runtime: { ...envelope.runtime, kind: "openclaw" },
        type: "health.snapshot",
        outcome: snapshot.overall === "healthy" ? "success" : "degraded",
        correlation: {},
        details: { status: snapshot.overall },
      }));
    };
    registerOpenClawHooks(api, {
      emit: persistEvent,
      envelopeFactory: (_input, _event, ctx) => ({ ...makeEnvelope(_input), correlation: { sessionId: ctx?.sessionId, turnId: ctx?.runId }, details: {} }),
      onDiagnostic: () => {},
    });

    api.registerService({
      id: "sidewisp-collector",
      async start(ctx) {
        if (!config.enabled) return;
        await auth.load();
        if (setupToken && !auth.canSend()) {
          try { await auth.enroll(setupToken); }
          catch { ctx.logger.warn("Sidewisp enrollment failed; will retry on restart"); }
        } else if (setupToken && auth.canSend()) {
          try { await auth.clearStoredSetupToken(); }
          catch { ctx.logger.warn("Sidewisp setup-token cleanup pending; will retry on restart"); }
        }
        spool = await openSpool({ file: path.join(stateDir, "sidewisp", "spool.sqlite") });
        if (preStartEvents.length > 0) {
          const installationId = auth.status().installationId;
          const ready = preStartEvents.splice(0).map((event) => installationId ? { ...event, installationId } : event);
          spool.enqueueSourceBatch("openclaw-hooks", String(ready.at(-1).sequence), ready);
        }
        const discovery = await discoverOpenClawSources(stateDir, api.runtime.version);
        for (const source of discovery.sources) {
          const stored = spool.cursor(source.file);
          let cursor = null;
          try { cursor = stored ? JSON.parse(stored) : null; } catch { cursor = null; }
          const recovered = await recoverJsonl(source.file, cursor);
          const events = recovered.facts.map((fact, index) => normalizeRuntimeEvent("openclaw", fact, makeEnvelope(fact, "log", `${source.ino}|${recovered.cursor.offset}|${index}`)).event).filter(Boolean);
          if (events.length > 0) spool.enqueueSourceBatch(source.file, JSON.stringify(recovered.cursor), events);
          else spool.advanceCursor(source.file, JSON.stringify(recovered.cursor));
        }
        uploader = createUploader({
          spool, endpoint: config.endpoint,
          credentialProvider: { current: async () => auth.credential() },
          onUpdate: (directive) => updates.schedule(directive),
        });
        uploadTimer = setInterval(() => { void uploader.drain({ maxAttempts: 1 }); }, 5_000);
        uploadTimer.unref?.();
        await collector.start();
        await emitHeartbeat();
        healthTimer = setInterval(() => { void emitHeartbeat(); }, 30_000);
        healthTimer.unref?.();
        ctx.logger.info(`Sidewisp collector ${VERSION} started (${auth.canSend() ? "configured" : "awaiting setup"})`);
      },
      async stop() {
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = null;
        if (uploadTimer) clearInterval(uploadTimer);
        uploadTimer = null;
        if (uploader) await uploader.drain({ maxAttempts: 1 });
        uploader = null;
        if (spool) await spool.close();
        spool = null;
        await collector.stop();
      },
    });

    api.registerGatewayMethod("sidewisp.status", async ({ respond }) => {
      respond(true, {
        plugin: "sidewisp",
        version: VERSION,
        enabled: config.enabled,
        configured: config.configured,
        endpoint: config.endpoint,
        mode: "zero-llm",
        installation: auth.status(),
        spool: spool?.health() ?? { status: config.enabled ? "starting" : "disabled" },
        uploader: uploader?.status() ?? { status: "not-started", sent: 0, remaining: 0, at: null },
        update: updates.status(),
        ...(await collector.status()),
      });
    }, { scope: "operator.read" });

    api.registerGatewayMethod("sidewisp.supportBundle", async ({ respond }) => {
      const collectorStatus = await collector.status();
      respond(true, createSafeSupportBundle({
        pluginVersion: VERSION, runtimeVersion: api.runtime.version, endpoint: config.endpoint,
        installation: auth.status(), spool: spool?.health(), uploader: uploader?.status(), collector: collectorStatus,
      }));
    }, { scope: "operator.read" });
  },
});
