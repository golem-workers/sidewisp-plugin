import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
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

test("runtime diagnostics coalesce latest-only and survive restart", async (t) => {
  const { file, spool } = await fixture(t);
  const first = { installationId: "sw_ins_test123456", snapshotId: "sw_diag_first" };
  const latest = { installationId: first.installationId, snapshotId: "sw_diag_latest" };
  spool.coalesceRuntimeDiagnostic(first);
  spool.coalesceRuntimeDiagnostic(latest);
  assert.deepEqual(spool.pendingRuntimeDiagnostic(first.installationId), {
    snapshotId: latest.snapshotId,
    snapshot: latest,
  });
  await spool.close();
  const reopened = await openSpool({ file });
  assert.equal(reopened.pendingRuntimeDiagnostic(first.installationId).snapshotId, latest.snapshotId);
  assert.equal(reopened.acknowledgeRuntimeDiagnostic(first.installationId, "sw_diag_first"), false);
  assert.equal(reopened.acknowledgeRuntimeDiagnostic(first.installationId, latest.snapshotId), true);
  assert.equal(reopened.pendingRuntimeDiagnostic(first.installationId), null);
  await reopened.close();
});

test("single writer lock and disk quota fail visibly", async (t) => {
  const { file, spool } = await fixture(t, { maxBytes: 4096 });
  await assert.rejects(openSpool({ file, maxBytes: 4096 }), (error) => error instanceof SpoolError && error.code === "locked");
  assert.throws(() => spool.enqueueSourceBatch("log", "1", [event("x"), { eventId: "large", data: "x".repeat(5000) }]), (error) => error.code === "quota-exceeded");
  assert.notEqual(spool.health().status, "healthy");
  await spool.close();
});

test("restart reclaims a dead PID writer lock without deleting a live lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-spool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "spool.sqlite");
  const lockFile = `${file}.lock`;
  await fs.writeFile(lockFile, `${JSON.stringify({ pid: 2_147_483_647, token: "dead", createdAtMs: 1 })}\n`, { mode: 0o600 });
  const spool = await openSpool({ file });
  await assert.rejects(openSpool({ file }), (error) => error instanceof SpoolError && error.code === "locked");
  await spool.close();
  await assert.rejects(fs.stat(lockFile), (error) => error.code === "ENOENT");
});

test("restart reclaims an old legacy empty writer lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-spool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "spool.sqlite");
  const lockFile = `${file}.lock`;
  await fs.writeFile(lockFile, "", { mode: 0o600 });
  await fs.utimes(lockFile, new Date(0), new Date(0));
  const spool = await openSpool({ file });
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

test("startup migrates and physically compacts a legacy ACK-filled spool", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-spool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "spool.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA auto_vacuum=NONE;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata(key,value) VALUES('schema_version','1');
    CREATE TABLE events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT NOT NULL, cursor TEXT NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER);
    CREATE TABLE cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE dead_letters (event_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    BEGIN;
  `);
  const insert = legacy.prepare("INSERT INTO events VALUES(?,?,?,?,?,?)");
  for (let index = 0; index < 2_000; index += 1) {
    insert.run(`acked-${index}`, JSON.stringify({ eventId: `acked-${index}`, data: "x".repeat(512) }), "legacy", "1", 1, 2);
  }
  legacy.exec("COMMIT");
  legacy.close();
  const before = (await fs.stat(file)).size;

  const spool = await openSpool({ file, now: () => 10 });
  assert.deepEqual(spool.pending(), []);
  await spool.close();

  const after = (await fs.stat(file)).size;
  const migrated = new DatabaseSync(file, { readOnly: true });
  const autoVacuum = migrated.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
  const remaining = migrated.prepare("SELECT count(*) AS count FROM events").get().count;
  migrated.close();
  assert.equal(autoVacuum, 2);
  assert.equal(remaining, 0);
  assert.ok(after < before / 2, `expected physical compaction (${before} -> ${after})`);
});

test("long acknowledged flow stays below quota and leaves no ACK tombstones", async (t) => {
  const maxBytes = 256 * 1024;
  const { file, spool } = await fixture(t, { maxBytes });
  for (let batch = 0; batch < 100; batch += 1) {
    const events = Array.from({ length: 25 }, (_, index) => ({
      ...event(`flow-${batch}-${index}`),
      data: "x".repeat(512),
    }));
    spool.enqueueSourceBatch("long-flow", String(batch), events);
    spool.acknowledge(events.map(({ eventId }) => eventId));
    assert.equal(spool.pending(1).length, 0);
    assert.ok(spool.health().bytes < maxBytes);
  }
  await spool.close();
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS count FROM events").get().count, 0);
  db.close();
});
