import { ADAPTER_CONTRACT, declareCapabilities, defineRuntimeAdapter } from "../../core/runtime-adapter.js";

export function createHermesAdapter({ hooks, state, version = "unknown" } = {}) {
  let unsubscribe = null;
  let running = false;
  return defineRuntimeAdapter({
    contract: ADAPTER_CONTRACT,
    id: "hermes",
    runtimeKind: "hermes",
    version: "0.1.0",
    runtimeVersion: version,
    capabilities: declareCapabilities([
      "lifecycle-hooks", "turn-hooks", "tool-hooks", "message-hooks", "provider-hooks",
      "log-recovery", "state-recovery", "process-health",
    ]),
    async start(context) {
      running = true;
      unsubscribe = hooks?.subscribe?.(context.emit) ?? null;
    },
    async stop() {
      await unsubscribe?.();
      unsubscribe = null;
      running = false;
    },
    async recover(cursor, context) {
      return state?.recover ? state.recover(cursor, context.emit) : cursor;
    },
    async healthSnapshot() { return { status: running ? "healthy" : "stopped" }; },
  });
}
