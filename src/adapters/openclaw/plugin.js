import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import crypto from "node:crypto";
import path from "node:path";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { readSetupToken, resolveConfig } from "../../../config.js";
import { createEnrollmentManager, createFileCredentialStore } from "../../auth/credentials.js";
import { createCollector } from "../../core/collector.js";
import { createAdapterRegistry } from "../../core/runtime-adapter.js";
import { openSpool } from "../../delivery/spool.js";
import { createUploader } from "../../delivery/uploader.js";
import { createOpenClawAdapter } from "./index.js";
import { registerOpenClawHooks } from "./hooks.js";

const VERSION = "0.1.0";

export default definePluginEntry({
  id: "sidewisp",
  name: "Sidewisp",
  description: "Zero-LLM runtime health and failure telemetry",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const setupToken = readSetupToken(api.pluginConfig);
    const stateDir = api.runtime.state.resolveStateDir();
    const auth = createEnrollmentManager({
      endpoint: config.endpoint,
      store: createFileCredentialStore({ stateDir }),
      clearSetupToken: async () => mutateConfigFile({ mutate(draft) {
        const entry = draft.plugins?.entries?.sidewisp;
        if (entry?.config && typeof entry.config === "object") delete entry.config.setupToken;
      } }),
    });
    const registry = createAdapterRegistry([createOpenClawAdapter({ logger: api.logger })]);
    const adapter = registry.select("openclaw");
    const collector = createCollector({ adapter });
    let sequence = 0;
    let spool = null;
    let uploader = null;
    let uploadTimer = null;
    const preStartEvents = [];
    const persistEvent = async (event) => {
      if (!spool) {
        if (preStartEvents.length < 1000) preStartEvents.push(event);
        return;
      }
      spool.enqueueSourceBatch("openclaw-hooks", String(event.sequence), [event]);
    };
    registerOpenClawHooks(api, {
      emit: persistEvent,
      envelopeFactory: (_input, _event, ctx) => {
        const now = new Date().toISOString();
        sequence += 1;
        return {
          eventId: `sw_evt_${crypto.randomUUID().replaceAll("-", "")}`,
          installationId: auth.status().installationId ?? "sw_ins_unconfigured",
          sequence, occurredAt: now, observedAt: now,
          runtime: { version: api.version ?? "unknown" },
          source: { kind: "hook", adapterVersion: VERSION },
          correlation: { sessionId: ctx?.sessionId, turnId: ctx?.runId }, details: {},
        };
      },
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
        }
        spool = await openSpool({ file: path.join(stateDir, "sidewisp", "spool.sqlite") });
        if (preStartEvents.length > 0) {
          spool.enqueueSourceBatch("openclaw-hooks", String(preStartEvents.at(-1).sequence), preStartEvents.splice(0));
        }
        uploader = createUploader({
          spool, endpoint: config.endpoint,
          credentialProvider: { current: async () => auth.credential() },
        });
        uploadTimer = setInterval(() => { void uploader.drain({ maxAttempts: 1 }); }, 5_000);
        uploadTimer.unref?.();
        await collector.start();
        ctx.logger.info(`Sidewisp collector ${VERSION} started (${config.configured ? "configured" : "awaiting setup"})`);
      },
      async stop() {
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
        ...(await collector.status()),
      });
    }, { scope: "operator.read" });
  },
});
