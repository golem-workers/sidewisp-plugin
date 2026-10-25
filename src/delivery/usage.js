import crypto from "node:crypto";
import { signBatch } from "./uploader.js";

export function createUsageDelivery({ collect, spool, endpoint, credentialProvider,
  fetchImpl = globalThis.fetch, now = Date.now, intervalMs = 5 * 60_000,
  timeoutMs = 15_000 } = {}) {
  if (typeof collect !== "function" || !spool || !credentialProvider) {
    throw new TypeError("usage delivery dependencies are required");
  }
  let timer = null;
  let running = null;
  let last = { status: "not-started", at: null, observations: 0 };
  const finish = (status, extra = {}) => {
    last = { status, at: new Date(now()).toISOString(), ...extra };
    return last;
  };
  const runOnce = async () => {
    if (running) return running;
    running = (async () => {
      const credential = await credentialProvider.current();
      if (!credential || credential.status !== "active") return finish("disabled");
      const collected = await collect({ installationId: credential.installationId, collectedAtMs: now() });
      const batchId = crypto.createHash("sha256").update(JSON.stringify(collected)).digest("base64url").slice(0, 32);
      spool.coalesceUsageBatch(credential.installationId, batchId, collected);
      const pending = spool.pendingUsageBatch(credential.installationId);
      const body = Buffer.from(JSON.stringify(pending.batch));
      const timestamp = Math.floor(now() / 1000).toString();
      const nonce = crypto.randomBytes(16).toString("base64url");
      const signature = signBatch({ secret: credential.secret, timestamp, nonce, body });
      let response;
      try {
        response = await fetchImpl(new URL("/v1/usage/batches", endpoint), {
          method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
          headers: { "content-type": "application/json",
            authorization: `Sidewisp ${credential.installationId}:${signature}`,
            "x-sidewisp-algorithm": "hmac-sha256-v1",
            "x-sidewisp-timestamp": timestamp, "x-sidewisp-nonce": nonce },
        });
      } catch { return finish("retry", { observations: collected.observations.length }); }
      if (response.status === 401 || response.status === 403) return finish("credential-rejected");
      if (response.status === 429 || response.status >= 500) return finish("retry");
      if (!response.ok) return finish("rejected", { httpStatus: response.status });
      const ack = await response.json();
      if (ack?.schema !== "sidewisp.usage-ack.v1") return finish("rejected");
      spool.acknowledgeUsageBatch(credential.installationId, pending.batchId);
      return finish("sent", { observations: ack.accepted, providerLimits: ack.providerLimits });
    })().finally(() => { running = null; });
    return running;
  };
  return Object.freeze({
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch(() => finish("error"));
      timer = setInterval(() => { void runOnce().catch(() => finish("error")); }, intervalMs);
      timer.unref?.();
    },
    async stop() { if (timer) clearInterval(timer); timer = null; await running; },
    status: () => ({ ...last }),
  });
}
