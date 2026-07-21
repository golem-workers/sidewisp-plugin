import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./config.js";

const VERSION = "0.1.0";

export default definePluginEntry({
  id: "sidewisp",
  name: "Sidewisp",
  description: "Zero-LLM OpenClaw health and failure telemetry",
  register(api) {
    const config = resolveConfig(api.pluginConfig);
    let startedAt = null;

    api.registerService({
      id: "sidewisp-collector",
      start(ctx) {
        startedAt = new Date().toISOString();
        ctx.logger.info(
          `Sidewisp collector ${VERSION} started (${config.configured ? "configured" : "awaiting setup"})`,
        );
      },
      stop() {
        startedAt = null;
      },
    });

    api.registerGatewayMethod(
      "sidewisp.status",
      ({ respond }) => {
        respond(true, {
          plugin: "sidewisp",
          version: VERSION,
          enabled: config.enabled,
          configured: config.configured,
          endpoint: config.endpoint,
          startedAt,
          mode: "zero-llm",
        });
      },
      { scope: "operator.read" },
    );
  },
});
