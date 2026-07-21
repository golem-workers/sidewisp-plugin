export const ADAPTER_CONTRACT = "sidewisp.runtime-adapter.v1";

export const CAPABILITIES = Object.freeze([
  "lifecycle-hooks",
  "turn-hooks",
  "tool-hooks",
  "message-hooks",
  "provider-hooks",
  "log-recovery",
  "state-recovery",
  "process-health",
]);

const CAPABILITY_STATES = new Set(["supported", "degraded", "unsupported"]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function declareCapabilities(supported = [], degraded = {}) {
  const supportedSet = new Set(supported);
  return Object.fromEntries(CAPABILITIES.map((name) => {
    if (Object.hasOwn(degraded, name)) return [name, { status: "degraded", reason: degraded[name] }];
    return [name, { status: supportedSet.has(name) ? "supported" : "unsupported" }];
  }));
}

export function defineRuntimeAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("adapter must be an object");
  if (adapter.contract !== ADAPTER_CONTRACT) throw new TypeError(`adapter contract must be ${ADAPTER_CONTRACT}`);
  for (const key of ["id", "runtimeKind", "version"]) {
    if (typeof adapter[key] !== "string" || !SAFE_ID.test(adapter[key])) throw new TypeError(`adapter.${key} is invalid`);
  }
  for (const name of CAPABILITIES) {
    const declaration = adapter.capabilities?.[name];
    if (!declaration || !CAPABILITY_STATES.has(declaration.status)) throw new TypeError(`capability ${name} must be explicit`);
    if (declaration.status === "degraded" && (typeof declaration.reason !== "string" || !SAFE_ID.test(declaration.reason))) {
      throw new TypeError(`degraded capability ${name} requires a stable reason`);
    }
  }
  for (const method of ["start", "stop", "healthSnapshot", "recover"]) {
    if (typeof adapter[method] !== "function") throw new TypeError(`adapter.${method} must be a function`);
  }
  return Object.freeze(adapter);
}

export function createAdapterRegistry(adapters) {
  const byRuntime = new Map();
  for (const adapter of adapters) {
    const valid = defineRuntimeAdapter(adapter);
    if (byRuntime.has(valid.runtimeKind)) throw new TypeError(`duplicate runtime adapter: ${valid.runtimeKind}`);
    byRuntime.set(valid.runtimeKind, valid);
  }
  return Object.freeze({
    list: () => [...byRuntime.values()],
    select(runtimeKind) {
      if (typeof runtimeKind !== "string" || runtimeKind.length === 0) throw new TypeError("runtimeKind must be selected explicitly");
      const adapter = byRuntime.get(runtimeKind);
      if (!adapter) throw new RangeError(`unsupported runtime: ${runtimeKind}`);
      return adapter;
    },
  });
}
