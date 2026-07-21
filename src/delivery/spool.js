import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SpoolError extends Error {
  constructor(code, message = code) { super(message); this.name = "SpoolError"; this.code = code; }
}

function initialize(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source TEXT NOT NULL, cursor TEXT NOT NULL, created_at INTEGER NOT NULL, acked_at INTEGER);
    CREATE INDEX IF NOT EXISTS events_pending ON events(acked_at, created_at);
    CREATE TABLE IF NOT EXISTS cursors (source TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS dead_letters (event_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") { db.close(); throw new SpoolError("corrupt", "spool integrity check failed"); }
  return db;
}

export async function openSpool({ file, maxBytes = 64 * 1024 * 1024, retentionMs = 7 * 86400_000, now = Date.now }) {
  if (!path.isAbsolute(file)) throw new TypeError("spool file must be absolute");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096) throw new TypeError("maxBytes is invalid");
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.chmod(path.dirname(file), 0o700);
  const lockFile = `${file}.lock`;
  let lock;
  try { lock = await fsp.open(lockFile, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new SpoolError("locked", "spool already has a writer"); throw error; }

  let db;
  let recoveredFromCorruption = false;
  try { db = initialize(file); }
  catch (error) {
    const corruptFile = `${file}.corrupt-${now()}`;
    try { await fsp.rename(file, corruptFile); recoveredFromCorruption = true; db = initialize(file); }
    catch { await lock.close(); await fsp.rm(lockFile, { force: true }); throw error; }
  }
  await fsp.chmod(file, 0o600);

  function diskUsage() {
    return [file, `${file}-wal`, `${file}-shm`].reduce((total, current) => {
      try { return total + fs.statSync(current).size; } catch { return total; }
    }, 0);
  }
  function assertQuota(extra = 0) {
    if (diskUsage() + extra > maxBytes) throw new SpoolError("quota-exceeded", "spool disk quota exceeded");
  }

  return Object.freeze({
    recoveredFromCorruption,
    enqueueSourceBatch(source, cursor, events, { beforeCommit } = {}) {
      if (!Array.isArray(events) || events.length === 0) throw new TypeError("events must be non-empty");
      const encoded = events.map((event) => ({ id: event.eventId, payload: JSON.stringify(event) }));
      assertQuota(encoded.reduce((sum, item) => sum + Buffer.byteLength(item.payload), 0));
      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare("INSERT OR IGNORE INTO events(event_id,payload,source,cursor,created_at) VALUES(?,?,?,?,?)");
        for (const item of encoded) insert.run(item.id, item.payload, source, cursor, now());
        db.prepare("INSERT INTO cursors(source,value,updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(source, cursor, now());
        beforeCommit?.();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    cursor(source) { return db.prepare("SELECT value FROM cursors WHERE source=?").get(source)?.value ?? null; },
    advanceCursor(source, cursor) {
      db.prepare("INSERT INTO cursors(source,value,updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(source, cursor, now());
    },
    pending(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("invalid limit");
      return db.prepare("SELECT event_id,payload FROM events WHERE acked_at IS NULL ORDER BY created_at,event_id LIMIT ?").all(limit)
        .map((row) => ({ eventId: row.event_id, event: JSON.parse(row.payload) }));
    },
    acknowledge(eventIds) {
      const update = db.prepare("UPDATE events SET acked_at=? WHERE event_id=? AND acked_at IS NULL");
      db.exec("BEGIN IMMEDIATE");
      try { for (const id of eventIds) update.run(now(), id); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    deadLetter(eventId, reason) {
      db.prepare("INSERT OR REPLACE INTO dead_letters(event_id,reason,created_at) VALUES(?,?,?)").run(eventId, reason, now());
      db.prepare("DELETE FROM events WHERE event_id=?").run(eventId);
    },
    prune() { return db.prepare("DELETE FROM events WHERE acked_at IS NOT NULL AND acked_at < ?").run(now() - retentionMs).changes; },
    health() { return { status: diskUsage() >= maxBytes ? "unhealthy" : diskUsage() >= maxBytes * 0.8 ? "degraded" : "healthy", bytes: diskUsage(), maxBytes, recoveredFromCorruption }; },
    async close() { db.close(); await lock.close(); await fsp.rm(lockFile, { force: true }); },
  });
}
