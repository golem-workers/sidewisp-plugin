export const HEALTH_SCHEMA = "sidewisp.health.v1";
export const HEALTH_CHECKS = Object.freeze(["process", "gateway", "config", "collector", "queue", "spool"]);

const CHECK_STATUSES = new Set(["healthy", "degraded", "unhealthy", "unsupported"]);
const SAFE_REASON = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function normalizeResult(name, value, durationMs) {
  if (!value || typeof value !== "object" || !CHECK_STATUSES.has(value.status)) {
    return { name, status: "degraded", reason: "invalid-probe-result", durationMs };
  }
  const result = { name, status: value.status, durationMs };
  if (value.reason !== undefined) {
    result.reason = typeof value.reason === "string" && SAFE_REASON.test(value.reason)
      ? value.reason
      : "invalid-probe-reason";
  }
  return result;
}

export async function runBoundedProbe(name, probe, { timeoutMs = 1_000, now = Date.now } = {}) {
  if (!HEALTH_CHECKS.includes(name)) throw new RangeError(`unknown health check: ${name}`);
  if (typeof probe !== "function") return { name, status: "unsupported", reason: "probe-unavailable", durationMs: 0 };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 5_000) throw new RangeError("timeoutMs must be between 10 and 5000");

  const controller = new AbortController();
  const started = now();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => probe({ signal: controller.signal })),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ status: "degraded", reason: "probe-timeout" });
        }, timeoutMs);
      }),
    ]);
    return normalizeResult(name, result, Math.max(0, now() - started));
  } catch {
    return { name, status: "degraded", reason: "probe-failed", durationMs: Math.max(0, now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

export function createHealthReporter({ identity, capabilities, probes = {}, timeoutMs = 1_000, now = () => new Date() }) {
  for (const name of Object.keys(probes)) {
    if (!HEALTH_CHECKS.includes(name)) throw new RangeError(`unknown health check: ${name}`);
  }
  if (Object.keys(probes).length > HEALTH_CHECKS.length) throw new RangeError("too many health probes");

  return Object.freeze({
    async snapshot() {
      const checks = await Promise.all(HEALTH_CHECKS.map((name) => runBoundedProbe(name, probes[name], { timeoutMs })));
      const supportedChecks = checks.filter(({ status }) => status !== "unsupported");
      const overall = supportedChecks.some(({ status }) => status === "unhealthy")
        ? "unhealthy"
        : supportedChecks.some(({ status }) => status === "degraded")
          ? "degraded"
          : supportedChecks.length === 0 ? "degraded" : "healthy";
      return {
        schema: HEALTH_SCHEMA,
        observedAt: now().toISOString(),
        runtime: { kind: identity.runtimeKind, version: identity.runtimeVersion },
        adapter: { id: identity.id, version: identity.version },
        overall,
        checks,
        capabilities,
      };
    },
  });
}
