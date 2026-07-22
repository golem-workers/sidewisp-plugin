import assert from "node:assert/strict";
import test from "node:test";
import { createUploader, signBatch } from "../src/delivery/uploader.js";

function memorySpool(events) {
  const pending = [...events];
  return {
    pending: (limit) => pending.slice(0, limit).map((event) => ({ eventId: event.eventId, event })),
    acknowledge(ids) { for (const id of ids) { const index = pending.findIndex((event) => event.eventId === id); if (index >= 0) pending.splice(index, 1); } },
    deadLetter(id) { this.acknowledge([id]); },
  };
}
const credential = { installationId: "sw_ins_fixture001", secret: `sw_secret_${"s".repeat(32)}`, status: "active" };

test("HMAC signing has a stable shared vector", () => {
  assert.equal(signBatch({ secret: "secret", timestamp: "1700000000", nonce: "nonce", body: '{"a":1}' }), "56f97b30c9dd771561bbba69fde102a544a232305e4c5ba421c9a7c5513a31d2");
});

test("secret is never transmitted and partial acknowledgements retain order", async () => {
  const spool = memorySpool([{ eventId: "a" }, { eventId: "b" }]);
  let request;
  const uploader = createUploader({ spool, endpoint: "https://sidewisp.test", credentialProvider: { current: async () => credential }, now: () => 1700000000000, nonce: () => "nonce", fetchImpl: async (_url, init) => {
    request = init;
    return { ok: true, status: 200, json: async () => ({ acknowledgedEventIds: ["a"] }) };
  } });
  assert.deepEqual(await uploader.sendOnce(), { status: "sent", sent: 1, remaining: 1 });
  assert.equal(JSON.stringify(request).includes(credential.secret), false);
  assert.equal(request.headers["x-sidewisp-algorithm"], "hmac-sha256-v1");
  assert.deepEqual(spool.pending(10).map(({ eventId }) => eventId), ["b"]);
});

test("backend outage retries with bounded backoff then drains in order", async () => {
  const spool = memorySpool([{ eventId: "a" }, { eventId: "b" }, { eventId: "c" }]);
  const delays = [];
  const delivered = [];
  let calls = 0;
  const uploader = createUploader({ spool, endpoint: "https://sidewisp.test", maxBatch: 2, random: () => 0, sleep: async (ms) => delays.push(ms), credentialProvider: { current: async () => credential }, fetchImpl: async (_url, init) => {
    calls += 1;
    if (calls <= 2) throw new Error("offline");
    const ids = JSON.parse(init.body).events.map(({ eventId }) => eventId);
    delivered.push(...ids);
    return { ok: true, status: 200, json: async () => ({ acknowledgedEventIds: ids }) };
  } });
  assert.equal((await uploader.drain({ maxAttempts: 10 })).status, "idle");
  assert.deepEqual(delays, [500, 1000]);
  assert.deepEqual(delivered, ["a", "b", "c"]);
  assert.equal(spool.pending(1).length, 0);
});

test("oversized event is dead-lettered without unbounded request memory", async () => {
  const spool = memorySpool([{ eventId: "large", value: "x".repeat(2000) }]);
  let fetched = false;
  const uploader = createUploader({ spool, endpoint: "https://sidewisp.test", maxBodyBytes: 1024, credentialProvider: { current: async () => credential }, fetchImpl: async () => { fetched = true; } });
  assert.equal((await uploader.sendOnce()).status, "dead-lettered");
  assert.equal(fetched, false);
});

test("server Retry-After overrides jittered backoff", async () => {
  const spool = memorySpool([{ eventId: "retry-one" }]); const delays = []; let calls = 0;
  const uploader = createUploader({ spool, endpoint: "https://sidewisp.test", credentialProvider: { current: async () => credential },
    sleep: async (ms) => delays.push(ms), fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => "7" } };
      return { ok: true, status: 200, json: async () => ({ acknowledgedEventIds: ["retry-one"], rejected: [] }) };
    } });
  assert.equal((await uploader.drain()).status, "idle"); assert.deepEqual(delays, [7000]);
});

test("gzip batches and partial rejection remove only terminal events", async () => {
  const spool = memorySpool([{ eventId: "accepted", value: "x".repeat(100) }, { eventId: "invalid", value: "y".repeat(100) }]); let request;
  const uploader = createUploader({ spool, endpoint: "https://sidewisp.test", compressThresholdBytes: 1,
    credentialProvider: { current: async () => credential }, fetchImpl: async (_url, init) => { request = init; return { ok: true, status: 200,
      json: async () => ({ acknowledgedEventIds: ["accepted"], rejected: [{ eventId: "invalid", code: "invalid_event" }] }) }; } });
  assert.equal((await uploader.sendOnce()).remaining, 0); assert.equal(request.headers["content-encoding"], "gzip");
});
