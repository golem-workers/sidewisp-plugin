import { ADAPTER_CONTRACT, declareCapabilities, defineRuntimeAdapter } from "../../core/runtime-adapter.js";
import { createHealthReporter } from "../../core/health.js";

export function createCodexAdapter({ hooks, version = "unknown", probes = {} } = {}) {
  let unsubscribe = null;
  const capabilities = declareCapabilities([
    "lifecycle-hooks",
    "turn-hooks",
    "tool-hooks",
    "process-health",
  ], {
    "message-hooks": "delivery-hook-unavailable",
    "provider-hooks": "provider-hook-unavailable",
  });
  const identity = { id: "codex", version: "0.2.0", runtimeKind: "codex", runtimeVersion: version };
  const health = createHealthReporter({ identity, capabilities, probes });
  return defineRuntimeAdapter({
    contract: ADAPTER_CONTRACT,
    id: "codex",
    runtimeKind: "codex",
    version: "0.2.0",
    runtimeVersion: version,
    capabilities,
    async start(context) {
      unsubscribe = hooks?.subscribe?.(context.emit) ?? null;
    },
    async stop() {
      await unsubscribe?.();
      unsubscribe = null;
    },
    async recover(cursor) { return cursor; },
    async healthSnapshot() { return health.snapshot(); },
  });
}
