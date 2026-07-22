import crypto from "node:crypto";
import { gzipSync } from "node:zlib";

export function signBatch({ secret, timestamp, nonce, body }) {
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = `${timestamp}\n${nonce}\n${digest}`;
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function createUploader({
  spool, credentialProvider, endpoint, fetchImpl = globalThis.fetch,
  now = () => Date.now(), nonce = () => crypto.randomBytes(16).toString("base64url"),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random,
  maxBatch = 100, maxBodyBytes = 256 * 1024, timeoutMs = 10_000, maxBackoffMs = 60_000, compressThresholdBytes = 1024,
}) {
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1 || maxBatch > 1000) throw new TypeError("invalid maxBatch");
  let attempt = 0;
  let lastResult = { status: "not-started", sent: 0, remaining: 0, at: null };
  const finish = (result) => {
    lastResult = { ...result, at: new Date(now()).toISOString() };
    return result;
  };

  async function sendOnce() {
    const credential = await credentialProvider.current();
    if (!credential || credential.status !== "active") return finish({ status: "disabled", sent: 0, remaining: spool.pending(1).length });
    const pending = spool.pending(maxBatch);
    if (pending.length === 0) { attempt = 0; return finish({ status: "idle", sent: 0, remaining: 0 }); }
    const jsonBody = Buffer.from(JSON.stringify({ schema: "sidewisp.telemetry-batch.v1", events: pending.map(({ event }) => event) }));
    if (jsonBody.length > maxBodyBytes) {
      spool.deadLetter(pending[0].eventId, "batch-event-too-large");
      return finish({ status: "dead-lettered", sent: 0, remaining: spool.pending(1).length });
    }
    const compressed = jsonBody.length >= compressThresholdBytes;
    const body = compressed ? gzipSync(jsonBody) : jsonBody;
    const timestamp = Math.floor(now() / 1000).toString();
    const requestNonce = nonce();
    const signature = signBatch({ secret: credential.secret, timestamp, nonce: requestNonce, body });
    let response;
    try {
      response = await fetchImpl(new URL("/v1/telemetry/batches", endpoint), {
        method: "POST", signal: AbortSignal.timeout(timeoutMs), body,
        headers: {
          "content-type": "application/json", "content-length": String(body.length),
          ...(compressed ? { "content-encoding": "gzip" } : {}),
          authorization: `Sidewisp ${credential.installationId}:${signature}`,
          "x-sidewisp-algorithm": "hmac-sha256-v1",
          "x-sidewisp-timestamp": timestamp, "x-sidewisp-nonce": requestNonce,
        },
      });
    } catch { return finish({ status: "retry", sent: 0, remaining: pending.length }); }
    if (response.status === 401 || response.status === 403) {
      await credentialProvider.refresh?.();
      return finish({ status: "credential-rejected", sent: 0, remaining: pending.length });
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      return finish({ status: "retry", sent: 0, remaining: pending.length,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: Math.min(maxBackoffMs, retryAfter * 1000) } : {}) });
    }
    if (!response.ok) return finish({ status: "rejected", sent: 0, remaining: pending.length });
    const result = await response.json();
    const sentIds = new Set(pending.map(({ eventId }) => eventId));
    const acknowledged = Array.isArray(result.acknowledgedEventIds)
      ? result.acknowledgedEventIds.filter((id) => sentIds.has(id)) : [];
    spool.acknowledge(acknowledged);
    if (Array.isArray(result.rejected)) {
      for (const rejected of result.rejected) {
        if (sentIds.has(rejected?.eventId) && typeof rejected.code === "string") spool.deadLetter(rejected.eventId, rejected.code);
      }
    }
    attempt = 0;
    return finish({ status: "sent", sent: acknowledged.length, remaining: spool.pending(1).length });
  }

  return Object.freeze({
    sendOnce,
    status: () => ({ ...lastResult }),
    async drain({ maxAttempts = 10 } = {}) {
      for (let count = 0; count < maxAttempts; count += 1) {
        const result = await sendOnce();
        if (["idle", "disabled", "credential-rejected", "rejected"].includes(result.status)) return result;
        if (result.status === "retry") {
          const delay = result.retryAfterMs ?? Math.min(maxBackoffMs, 1000 * 2 ** attempt) * (0.5 + random() * 0.5);
          attempt = Math.min(attempt + 1, 20);
          await sleep(Math.round(delay));
        }
      }
      return finish({ status: "backpressure", sent: 0, remaining: spool.pending(1).length });
    },
  });
}
