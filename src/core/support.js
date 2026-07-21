const SCHEMA = "sidewisp.support-bundle.v1";

function capabilitySummary(capabilities = {}) {
  return Object.fromEntries(Object.entries(capabilities).map(([name, value]) => [name, {
    status: value?.status ?? "unsupported",
    ...(value?.reason ? { reason: value.reason } : {}),
  }]));
}

export function createSafeSupportBundle({ pluginVersion, runtimeVersion, endpoint, installation, spool, uploader, collector, diagnostic = null, generatedAt = new Date().toISOString() }) {
  return Object.freeze({
    schema: SCHEMA,
    generatedAt,
    plugin: { id: "sidewisp", version: pluginVersion, mode: "zero-llm" },
    runtime: { kind: collector?.runtime ?? "unknown", version: runtimeVersion, adapter: collector?.adapter ?? null, compatible: collector?.runtime === "openclaw" },
    configuration: { endpointOrigin: new URL(endpoint).origin, installationState: installation?.state ?? "unconfigured" },
    collector: { running: Boolean(collector?.running), startedAt: collector?.startedAt ?? null, capabilities: capabilitySummary(collector?.capabilities) },
    spool: { status: spool?.status ?? "unavailable", bytes: spool?.bytes ?? 0, maxBytes: spool?.maxBytes ?? 0, recoveredFromCorruption: Boolean(spool?.recoveredFromCorruption) },
    uploader: { status: uploader?.status ?? "not-started", sent: uploader?.sent ?? 0, remaining: uploader?.remaining ?? 0, at: uploader?.at ?? null },
    diagnostic: diagnostic ? { code: diagnostic.code, reason: diagnostic.reason, localOnly: true } : null,
  });
}
