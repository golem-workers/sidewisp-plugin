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
import { openSpool, SpoolError } from "../../delivery/spool.js";
import { createUploader } from "../../delivery/uploader.js";
import { createRuntimeDiagnosticsDelivery } from "../../delivery/runtime-diagnostics.js";
import { createOpenClawAdapter } from "./index.js";
import {
  createOpenClawUserTaskLifecycle,
  openClawAgentEventInput,
  registerOpenClawHooks,
} from "./hooks.js";
import { discoverOpenClawSources, recoverJsonl, stableOpenClawEventId } from "./recovery.js";
import { createUpdateScheduler } from "../../update/scheduler.js";

const VERSION = "0.2.18";

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
        collector: async () => spool
          ? { status: "healthy" }
          : { status: "degraded", reason: spoolFailure?.code ?? "starting" },
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
    let runtimeDiagnostics = null;
    let uploadTimer = null;
    let healthTimer = null;
    let spoolFailure = null;
    let spoolFailureCount = 0;
    const preStartEvents = [];
    const agentEventTelemetry = { observed: 0, emitted: 0, ignored: 0, failed: 0, lastObservedAt: null };
    let persistDeferredEvent = async () => false;
    const userTaskLifecycle = createOpenClawUserTaskLifecycle({
      async onDeferred(event) {
        try {
          if (await persistDeferredEvent(event)) agentEventTelemetry.emitted += 1;
          else agentEventTelemetry.failed += 1;
        } catch {
          agentEventTelemetry.failed += 1;
        }
      },
      onSuppressed() {
        agentEventTelemetry.ignored += 1;
      },
    });
    const recordSpoolFailure = (error) => {
      spoolFailureCount += 1;
      spoolFailure = { code: error.code, at: new Date().toISOString() };
      if (spoolFailureCount === 1 || (spoolFailureCount & (spoolFailureCount - 1)) === 0) {
        api.logger.warn(`Sidewisp spool failure isolated from gateway (${error.code}; count=${spoolFailureCount})`);
      }
    };
    const runDetached = (label, operation) => {
      void Promise.resolve().then(operation).catch((error) => {
        if (error instanceof SpoolError) recordSpoolFailure(error);
        else api.logger.warn(`Sidewisp ${label} failed; gateway continues`);
      });
    };
    const enqueueAcceptedEvent = async (acceptedEvent) => {
      if (!spool) {
        if (preStartEvents.length >= 1000) return false;
        preStartEvents.push(acceptedEvent);
        return true;
      }
      try {
        spool.enqueueSourceBatch("openclaw-hooks", String(acceptedEvent.sequence), [acceptedEvent]);
        return true;
      } catch (error) {
        if (!(error instanceof SpoolError)) throw error;
        recordSpoolFailure(error);
        return false;
      }
    };
    persistDeferredEvent = enqueueAcceptedEvent;
    const persistEventDetailed = async (event) => {
      const result = userTaskLifecycle.processDetailed(event);
      if (result.disposition !== "accepted") return result;
      return Object.freeze({
        disposition: await enqueueAcceptedEvent(result.event) ? "emitted" : "failed",
        event: result.event,
      });
    };
    const persistEvent = async (event) => (await persistEventDetailed(event)).disposition === "emitted";
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
    const hookTelemetry = registerOpenClawHooks(api, {
      emit: persistEvent,
      envelopeFactory: (_input, _event, ctx) => ({ ...makeEnvelope(_input), correlation: { sessionId: ctx?.sessionId, turnId: ctx?.runId }, details: {} }),
      onDiagnostic: () => {},
    });
    api.agent.events.registerAgentEventSubscription({
      id: "sidewisp-runtime-events",
      description: "Content-free Sidewisp lifecycle and tool failure telemetry",
      streams: ["lifecycle", "tool", "approval"],
      async handle(event) {
        agentEventTelemetry.observed += 1;
        agentEventTelemetry.lastObservedAt = new Date().toISOString();
        const input = openClawAgentEventInput(event);
        if (!input) {
          agentEventTelemetry.ignored += 1;
          return;
        }
        try {
          const result = normalizeRuntimeEvent("openclaw", input, makeEnvelope(input, "hook"));
          if (!result.event) {
            agentEventTelemetry.ignored += 1;
            return;
          }
          const persisted = await persistEventDetailed(result.event);
          if (persisted.disposition === "emitted") agentEventTelemetry.emitted += 1;
          else if (persisted.disposition === "failed") agentEventTelemetry.failed += 1;
          else if (persisted.disposition === "coalesced") agentEventTelemetry.ignored += 1;
        } catch {
          agentEventTelemetry.failed += 1;
        }
      },
    });

    api.registerService({
      id: "sidewisp-collector",
      async start(ctx) {
        if (!config.enabled) return;
        try {
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
          runtimeDiagnostics = createRuntimeDiagnosticsDelivery({
            adapter, spool, endpoint: config.endpoint,
            credentialProvider: { current: async () => auth.credential() },
            intervalMs: config.diagnosticsIntervalMs,
            maxRefreshMs: config.diagnosticsMaxRefreshMs,
          });
          runtimeDiagnostics.start();
          uploadTimer = setInterval(() => runDetached("upload", () => uploader.drain({ maxAttempts: 1 })), 5_000);
          uploadTimer.unref?.();
          await collector.start();
          await emitHeartbeat();
          healthTimer = setInterval(() => runDetached("heartbeat", emitHeartbeat), 30_000);
          healthTimer.unref?.();
          ctx.logger.info(`Sidewisp collector ${VERSION} started (${auth.canSend() ? "configured" : "awaiting setup"})`);
        } catch (error) {
          if (!(error instanceof SpoolError)) throw error;
          recordSpoolFailure(error);
          if (healthTimer) clearInterval(healthTimer);
          healthTimer = null;
          if (uploadTimer) clearInterval(uploadTimer);
          uploadTimer = null;
          if (runtimeDiagnostics) await runtimeDiagnostics.stop().catch(() => {});
          runtimeDiagnostics = null;
          if (spool) await spool.close().catch(() => {});
          spool = null;
          uploader = null;
          ctx.logger.error(`Sidewisp collector disabled after spool failure (${error.code}); gateway continues`);
        }
      },
      async stop() {
        if (healthTimer) clearInterval(healthTimer);
        healthTimer = null;
        if (uploadTimer) clearInterval(uploadTimer);
        uploadTimer = null;
        await userTaskLifecycle.flushPending();
        if (uploader) {
          try { await uploader.drain({ maxAttempts: 1 }); }
          catch (error) {
            if (error instanceof SpoolError) recordSpoolFailure(error);
            else api.logger.warn("Sidewisp final upload failed during shutdown");
          }
        }
        uploader = null;
        if (runtimeDiagnostics) {
          try { await runtimeDiagnostics.stop(); }
          catch (error) {
            if (error instanceof SpoolError) recordSpoolFailure(error);
            else api.logger.warn("Sidewisp diagnostics stop failed during shutdown");
          }
        }
        runtimeDiagnostics = null;
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
        configured: auth.canSend(),
        endpoint: config.endpoint,
        mode: "zero-llm",
        installation: auth.status(),
        spool: spool?.health() ?? { status: config.enabled ? "starting" : "disabled" },
        uploader: uploader?.status() ?? { status: "not-started", sent: 0, remaining: 0, at: null },
        runtimeDiagnostics: runtimeDiagnostics?.status() ?? { status: "not-started", at: null },
        update: updates.status(),
        hooks: hookTelemetry.status(),
        agentEvents: { ...agentEventTelemetry },
        userTasks: userTaskLifecycle.status(),
        failures: { spool: spoolFailure, spoolCount: spoolFailureCount },
        ...(await collector.status()),
      });
    }, { scope: "operator.read" });

    api.registerGatewayMethod("sidewisp.supportBundle", async ({ respond }) => {
      const collectorStatus = await collector.status();
      respond(true, createSafeSupportBundle({
        pluginVersion: VERSION, runtimeVersion: api.runtime.version, endpoint: config.endpoint,
        installation: auth.status(), spool: spool?.health(), uploader: uploader?.status(), collector: collectorStatus,
        diagnostic: runtimeDiagnostics?.status(),
      }));
    }, { scope: "operator.read" });
  },
});
