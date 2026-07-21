import crypto from "node:crypto";

export function signBatch({ secret, timestamp, nonce, body }) {
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = `${timestamp}\n${nonce}\n${digest}`;
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

export function createUploader({
  spool, credentialProvider, endpoint, fetchImpl = globalThis.fetch,
  now = () => Date.now(), nonce = () => crypto.randomBytes(16).toString("base64url"),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random,
  maxBatch = 100, maxBodyBytes = 256 * 1024, timeoutMs = 10_000, maxBackoffMs = 60_000,
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
    const body = JSON.stringify({ schema: "sidewisp.telemetry-batch.v1", events: pending.map(({ event }) => event) });
    if (Buffer.byteLength(body) > maxBodyBytes) {
      spool.deadLetter(pending[0].eventId, "batch-event-too-large");
      return finish({ status: "dead-lettered", sent: 0, remaining: spool.pending(1).length });
    }
    const timestamp = Math.floor(now() / 1000).toString();
    const requestNonce = nonce();
    const signature = signBatch({ secret: credential.secret, timestamp, nonce: requestNonce, body });
    let response;
    try {
      response = await fetchImpl(new URL("/v1/telemetry/batches", endpoint), {
        method: "POST", signal: AbortSignal.timeout(timeoutMs), body,
        headers: {
          "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
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
    if (response.status === 429 || response.status >= 500) return finish({ status: "retry", sent: 0, remaining: pending.length });
    if (!response.ok) return finish({ status: "rejected", sent: 0, remaining: pending.length });
    const result = await response.json();
    const sentIds = new Set(pending.map(({ eventId }) => eventId));
    const acknowledged = Array.isArray(result.acknowledgedEventIds)
      ? result.acknowledgedEventIds.filter((id) => sentIds.has(id)) : [];
    spool.acknowledge(acknowledged);
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
          const delay = Math.min(maxBackoffMs, 1000 * 2 ** attempt) * (0.5 + random() * 0.5);
          attempt = Math.min(attempt + 1, 20);
          await sleep(Math.round(delay));
        }
      }
      return finish({ status: "backpressure", sent: 0, remaining: spool.pending(1).length });
    },
  });
}
