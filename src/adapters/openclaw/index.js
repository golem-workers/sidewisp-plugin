import { ADAPTER_CONTRACT, declareCapabilities, defineRuntimeAdapter } from "../../core/runtime-adapter.js";
import { createHealthReporter } from "../../core/health.js";
import { collectRuntimeDiagnostics } from "../../core/diagnostics.js";

export function createOpenClawAdapter({
  logger, version = "unknown", probes = {}, diagnosticProbes = {}, installationId = "sw_ins_unconfigured",
} = {}) {
  let running = false;
  const capabilities = declareCapabilities([
    "lifecycle-hooks", "turn-hooks", "tool-hooks", "message-hooks",
    "log-recovery", "process-health", "diagnostics-probe",
  ]);
  const identity = { id: "openclaw", version: "0.1.0", runtimeKind: "openclaw", runtimeVersion: version };
  const health = createHealthReporter({ identity, capabilities, probes });
  return defineRuntimeAdapter({
    contract: ADAPTER_CONTRACT,
    id: "openclaw",
    runtimeKind: "openclaw",
    version: "0.1.0",
    runtimeVersion: version,
    capabilities,
    async start() {
      running = true;
      logger?.info?.("Sidewisp OpenClaw adapter started");
    },
    async stop() { running = false; },
    async recover(cursor) { return cursor; },
    async healthSnapshot() { return health.snapshot(); },
    async collectDiagnostics(options = {}) {
      return collectRuntimeDiagnostics({
        installationId, runtimeKind: "openclaw", runtimeVersion: version,
        adapterName: "sidewisp.openclaw", adapterVersion: "0.1.0",
        probes: diagnosticProbes, ...options,
      });
    },
  });
}
