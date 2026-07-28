import crypto from "node:crypto";
import { signBatch } from "./uploader.js";

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_MAX_REFRESH_MS = 60 * 60_000;

function contentFingerprint(snapshot) {
  const comparable = {
    ...snapshot,
    snapshotId: undefined,
    observedAt: undefined,
  };
  return crypto.createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
}

export function createRuntimeDiagnosticsDelivery({
  adapter, spool, credentialProvider, endpoint, fetchImpl = globalThis.fetch,
  now = Date.now, random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout,
  intervalMs = DEFAULT_INTERVAL_MS, maxRefreshMs = DEFAULT_MAX_REFRESH_MS,
  timeoutMs = 10_000, maxBackoffMs = 60_000,
}) {
  let timer = null;
  let running = null;
  let stopped = true;
  let lastFingerprint = null;
  let lastQueuedAt = 0;
  let retryAttempt = 0;
  let lastResult = { status: "not-started", at: null };

  const finish = (status, extra = {}) => {
    lastResult = { status, ...extra, at: new Date(now()).toISOString() };
    return lastResult;
  };
  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimer(() => {
      timer = null;
      void run().then((result) => {
        schedule(result.status === "retry" ? retryDelayMs() : intervalMs);
      }, () => schedule(retryDelayMs()));
    }, Math.max(0, Math.round(delayMs)));
    timer?.unref?.();
  };

  async function collect() {
    const credential = await credentialProvider.current();
    if (!credential || credential.status !== "active") return finish("disabled");
    const snapshot = await adapter.collectDiagnostics({
      installationId: credential.installationId,
      observedAt: new Date(now()).toISOString(),
    });
    const fingerprint = contentFingerprint(snapshot);
    if (fingerprint !== lastFingerprint || now() - lastQueuedAt >= maxRefreshMs) {
      spool.coalesceRuntimeDiagnostic(snapshot);
      lastFingerprint = fingerprint;
      lastQueuedAt = now();
    }
    return snapshot;
  }

  async function upload() {
    const credential = await credentialProvider.current();
    if (!credential || credential.status !== "active") return finish("disabled");
    const pending = spool.pendingRuntimeDiagnostic(credential.installationId);
    if (!pending) {
      retryAttempt = 0;
      return finish("idle");
    }
    const body = Buffer.from(JSON.stringify(pending.snapshot));
    const timestamp = Math.floor(now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString("base64url");
    const signature = signBatch({ secret: credential.secret, timestamp, nonce, body });
    let response;
    try {
      response = await fetchImpl(new URL("/v1/runtime-diagnostics/snapshots", endpoint), {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        body,
        headers: {
          "content-type": "application/json",
          authorization: `Sidewisp ${credential.installationId}:${signature}`,
          "x-sidewisp-algorithm": "hmac-sha256-v1",
          "x-sidewisp-timestamp": timestamp,
          "x-sidewisp-nonce": nonce,
        },
      });
    } catch {
      retryAttempt = Math.min(retryAttempt + 1, 20);
      return finish("retry", { pending: true });
    }
    if (response.status === 401 || response.status === 403) {
      await credentialProvider.refresh?.();
      return finish("credential-rejected", { pending: true });
    }
    if (response.status === 429 || response.status >= 500) {
      retryAttempt = Math.min(retryAttempt + 1, 20);
      return finish("retry", { pending: true });
    }
    if (!response.ok) return finish("rejected", { pending: true });
    const ack = await response.json();
    if (ack?.snapshotId !== pending.snapshotId) return finish("invalid-ack", { pending: true });
    spool.acknowledgeRuntimeDiagnostic(credential.installationId, pending.snapshotId);
    retryAttempt = 0;
    return finish("sent", { snapshotId: pending.snapshotId, pending: false });
  }

  async function execute() {
    await collect();
    return upload();
  }
  function run() {
    if (running) return running;
    running = execute().finally(() => { running = null; });
    return running;
  }
  function retryDelayMs() {
    return Math.min(maxBackoffMs, 1000 * 2 ** retryAttempt) * (0.5 + random() * 0.5);
  }

  return Object.freeze({
    run,
    collect,
    upload,
    status: () => ({ ...lastResult }),
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(random() * intervalMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
      if (running) await running;
      await upload();
    },
    retryDelayMs,
  });
}
