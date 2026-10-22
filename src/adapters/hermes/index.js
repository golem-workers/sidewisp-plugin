import { ADAPTER_CONTRACT, declareCapabilities, defineRuntimeAdapter } from "../../core/runtime-adapter.js";
import { createHealthReporter } from "../../core/health.js";
import { collectRuntimeDiagnostics, unsupportedDiagnostics } from "../../core/diagnostics.js";

export function createHermesAdapter({ hooks, state, version = "unknown", probes = {}, diagnosticProbes = {} } = {}) {
  let unsubscribe = null;
  let running = false;
  const capabilities = declareCapabilities([
    "lifecycle-hooks", "turn-hooks", "tool-hooks", "provider-hooks",
    "log-recovery", "state-recovery", "process-health",
    ...(Object.keys(diagnosticProbes).length ? ["diagnostics-probe"] : []),
  ], { "message-hooks": "delivery-hook-unavailable" });
  const identity = { id: "hermes", version: "0.1.0", runtimeKind: "hermes", runtimeVersion: version };
  const health = createHealthReporter({ identity, capabilities, probes });
  return defineRuntimeAdapter({
    contract: ADAPTER_CONTRACT,
    id: "hermes",
    runtimeKind: "hermes",
    version: "0.1.0",
    runtimeVersion: version,
    capabilities,
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
    async healthSnapshot() { return health.snapshot(); },
    async collectDiagnostics({ installationId = "sw_ins_unconfigured", now = () => Date.now(), ttlSeconds = 900 } = {}) {
      if(!Object.keys(diagnosticProbes).length)return unsupportedDiagnostics({installationId,runtimeKind:"hermes",runtimeVersion:version,adapterName:"sidewisp.hermes",adapterVersion:"0.1.0",observedAt:new Date(now()).toISOString(),ttlSeconds});
      return collectRuntimeDiagnostics({
        installationId, runtimeKind: "hermes", runtimeVersion: version,
        adapterName: "sidewisp.hermes", adapterVersion: "0.1.0",
        probes:diagnosticProbes, now, ttlSeconds,
      });
    },
  });
}
