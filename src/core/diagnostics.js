import crypto from "node:crypto";

export const DIAGNOSTICS_SCHEMA = "sidewisp.runtime-diagnostics.v1";
export const DIAGNOSTIC_SECTIONS = Object.freeze([
  "runtime", "configuration", "connectivity", "storage", "scheduler",
  "integrations", "updates",
]);
const OUTCOMES = new Set(["ok", "degraded", "unsupported", "error"]);
const STATUSES = new Set(["ok", "degraded", "unhealthy", "unknown", "unsupported"]);
const SEVERITIES = new Set(["info", "warning", "error"]);
const SAFE_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROHIBITED = /prompt|message|content|body|payload|argument|result|log|command|environment|credential|api.?key|token|password|secret|path|file|email/i;

function safeId(value, fallback = "unknown", max = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && SAFE_KEY.test(value) && !PROHIBITED.test(value) ? value : fallback;
}

function normalizeFact(fact) {
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) return null;
  const key = safeId(fact.key, "", 128);
  if (!key || !STATUSES.has(fact.status) || !SEVERITIES.has(fact.severity)) return null;
  const scalar = typeof fact.value === "boolean"
    || (typeof fact.value === "number" && Number.isFinite(fact.value))
    || (typeof fact.value === "string" && fact.value.length > 0
      && fact.value.length <= 128 && !PROHIBITED.test(fact.value));
  if (!scalar) return null;
  return {
    key,
    status: fact.status,
    severity: fact.severity,
    value: fact.value,
    ...(fact.unit ? { unit: safeId(fact.unit, "unknown", 32) } : {}),
    ...(fact.source ? { source: safeId(fact.source, "unknown", 64) } : {}),
  };
}

function normalizeSection(key, result) {
  const outcome = OUTCOMES.has(result?.outcome) ? result.outcome : "error";
  const facts = Array.isArray(result?.facts)
    ? result.facts.map(normalizeFact).filter(Boolean)
      .sort((left, right) => left.key.localeCompare(right.key)).slice(0, 64)
    : [];
  return { key, outcome, facts };
}

function timeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("probe_timeout"), { code: "probe_timeout" })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function unsupportedDiagnostics({
  installationId, runtimeKind, runtimeVersion = "unknown", adapterName, adapterVersion,
  observedAt = new Date().toISOString(), ttlSeconds = 900,
}) {
  return finalize({
    installationId, runtimeKind, runtimeVersion, adapterName, adapterVersion,
    observedAt, ttlSeconds, collection: { outcome: "unsupported", code: "diagnostics_unsupported" },
    sections: [],
  });
}

function finalize({
  installationId, runtimeKind, runtimeVersion, adapterName, adapterVersion,
  observedAt, ttlSeconds, collection, sections,
}) {
  const base = {
    schema: DIAGNOSTICS_SCHEMA,
    installationId,
    observedAt,
    ttlSeconds,
    runtime: { kind: ["openclaw", "hermes"].includes(runtimeKind) ? runtimeKind : "other",
      ...(runtimeKind === "openclaw" || runtimeKind === "hermes" ? {} : { name: safeId(runtimeKind) }),
      version: safeId(runtimeVersion) },
    adapter: { name: safeId(adapterName), version: safeId(adapterVersion) },
    collection,
    sections,
    truncation: { truncated: false, omittedSections: 0, omittedFacts: 0 },
  };
  const digest = crypto.createHash("sha256").update(JSON.stringify(base)).digest("base64url");
  return { ...base, snapshotId: `sw_diag_${digest}` };
}

export async function collectRuntimeDiagnostics({
  installationId, runtimeKind, runtimeVersion, adapterName, adapterVersion,
  probes = {}, now = () => Date.now(), ttlSeconds = 900, timeoutMs = 2_000,
}) {
  const sections = [];
  let failures = 0;
  for (const key of DIAGNOSTIC_SECTIONS) {
    const probe = probes[key];
    if (typeof probe !== "function") {
      sections.push({ key, outcome: "unsupported", facts: [] });
      continue;
    }
    try {
      sections.push(normalizeSection(key, await timeout(probe(), timeoutMs)));
    } catch {
      failures += 1;
      sections.push({ key, outcome: "error", facts: [] });
    }
  }
  const degraded = sections.some(({ outcome }) => outcome === "degraded");
  const supported = sections.some(({ outcome }) => outcome !== "unsupported");
  return finalize({
    installationId, runtimeKind, runtimeVersion, adapterName, adapterVersion,
    observedAt: new Date(now()).toISOString(), ttlSeconds,
    collection: !supported ? { outcome: "unsupported", code: "diagnostics_unsupported" }
      : failures === sections.length ? { outcome: "error", code: "probe_failed" }
        : failures > 0 || degraded ? { outcome: "degraded", code: failures > 0 ? "partial_collection" : "degraded" }
          : { outcome: "ok" },
    sections,
  });
}
