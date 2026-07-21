import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSpool, SpoolError } from "../src/delivery/spool.js";

const event = (id) => ({ eventId: id, schema: "sidewisp.telemetry.v1", type: "tool.failed" });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-spool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "spool.sqlite"), spool: await openSpool({ file: path.join(root, "spool.sqlite"), ...options }) };
}

test("event writes and cursor advancement commit atomically", async (t) => {
  const { spool } = await fixture(t);
  assert.throws(() => spool.enqueueSourceBatch("log", "11", [event("evt-1")], { beforeCommit() { throw new Error("crash"); } }), /crash/);
  assert.equal(spool.cursor("log"), null);
  assert.deepEqual(spool.pending(), []);
  spool.enqueueSourceBatch("log", "11", [event("evt-1")]);
  assert.equal(spool.cursor("log"), "11");
  assert.deepEqual(spool.pending().map(({ eventId }) => eventId), ["evt-1"]);
  await spool.close();
});

test("restart safely replays incomplete delivery and acknowledgements are idempotent", async (t) => {
  const { file, spool } = await fixture(t);
  spool.enqueueSourceBatch("state", "2", [event("evt-2")]);
  await spool.close();
  const reopened = await openSpool({ file });
  assert.equal(reopened.pending().length, 1);
  reopened.acknowledge(["evt-2", "evt-2"]);
  assert.equal(reopened.pending().length, 0);
  await reopened.close();
});

test("single writer lock and disk quota fail visibly", async (t) => {
  const { file, spool } = await fixture(t, { maxBytes: 4096 });
  await assert.rejects(openSpool({ file, maxBytes: 4096 }), (error) => error instanceof SpoolError && error.code === "locked");
  assert.throws(() => spool.enqueueSourceBatch("log", "1", [event("x"), { eventId: "large", data: "x".repeat(5000) }]), (error) => error.code === "quota-exceeded");
  assert.notEqual(spool.health().status, "healthy");
  await spool.close();
});

test("corrupt database is quarantined and recovered", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-spool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "spool.sqlite");
  await fs.writeFile(file, "not sqlite");
  const spool = await openSpool({ file, now: () => 123 });
  assert.equal(spool.recoveredFromCorruption, true);
  assert.ok((await fs.readdir(root)).includes("spool.sqlite.corrupt-123"));
  await spool.close();
});
