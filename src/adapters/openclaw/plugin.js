import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "../../../config.js";
import { createCollector } from "../../core/collector.js";
import { createAdapterRegistry } from "../../core/runtime-adapter.js";
import { createOpenClawAdapter } from "./index.js";

const VERSION = "0.1.0";

export default definePluginEntry({
  id: "sidewisp",
  name: "Sidewisp",
  description: "Zero-LLM runtime health and failure telemetry",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    const registry = createAdapterRegistry([createOpenClawAdapter({ logger: api.logger })]);
    const adapter = registry.select("openclaw");
    const collector = createCollector({ adapter });

    api.registerService({
      id: "sidewisp-collector",
      async start(ctx) {
        await collector.start();
        ctx.logger.info(`Sidewisp collector ${VERSION} started (${config.configured ? "configured" : "awaiting setup"})`);
      },
      async stop() { await collector.stop(); },
    });

    api.registerGatewayMethod("sidewisp.status", async ({ respond }) => {
      respond(true, {
        plugin: "sidewisp",
        version: VERSION,
        enabled: config.enabled,
        configured: config.configured,
        endpoint: config.endpoint,
        mode: "zero-llm",
        ...(await collector.status()),
      });
    }, { scope: "operator.read" });
  },
});
