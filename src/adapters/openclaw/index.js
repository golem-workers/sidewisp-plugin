import { ADAPTER_CONTRACT, declareCapabilities, defineRuntimeAdapter } from "../../core/runtime-adapter.js";

export function createOpenClawAdapter({ logger, version = "unknown" }) {
  let running = false;
  return defineRuntimeAdapter({
    contract: ADAPTER_CONTRACT,
    id: "openclaw",
    runtimeKind: "openclaw",
    version: "0.1.0",
    runtimeVersion: version,
    capabilities: declareCapabilities([
      "lifecycle-hooks", "log-recovery", "process-health",
    ]),
    async start() {
      running = true;
      logger?.info?.("Sidewisp OpenClaw adapter started");
    },
    async stop() { running = false; },
    async recover(cursor) { return cursor; },
    async healthSnapshot() { return { status: running ? "healthy" : "stopped" }; },
  });
}
