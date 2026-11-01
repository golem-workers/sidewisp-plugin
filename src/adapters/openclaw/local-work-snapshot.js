import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// This adapter uses the same read-only, local session index as context telemetry.
// It never reads transcripts or invokes the trusted-plugin-only Gateway API.
export function createLocalWorkSnapshotRequest({ stateDir, activeWork, now = Date.now } = {}) {
  return async (method, { limit = 100, offset = 0 } = {}) => {
    if (method !== "sessions.list") throw new Error("unsupported_work_snapshot_method");
    const keys = [...new Set(activeWork().map(work => work.sessionId))];
    const selected = keys.slice(offset, offset + Math.min(100, limit));
    const sessions = [];
    for (const key of selected) {
      const agent = /^agent:([a-zA-Z0-9_-]+):/.exec(key)?.[1];
      if (!agent) continue;
      const root = path.join(stateDir, "agents", agent);
      let entry, db;
      try {
        const file = path.join(root, "agent", "openclaw-agent.sqlite");
        await fs.access(file);
        db = new DatabaseSync(file, { readOnly: true });
        const row = db.prepare("SELECT entry_json FROM session_nodes WHERE session_key=? AND entry_valid=1 AND archived_at IS NULL").get(key);
        if (row) entry = JSON.parse(row.entry_json);
      } catch {
        // Legacy runtimes have a JSON index. A missing/invalid index proves nothing.
        try {
          const file = path.join(root, "sessions", "sessions.json");
          if ((await fs.stat(file)).size <= 2 * 1024 * 1024) entry = JSON.parse(await fs.readFile(file, "utf8"))[key];
        } catch { /* unknown */ }
      } finally { db?.close(); }
      if (!entry || entry.archivedAt) continue;
      const terminal = ["done", "error", "aborted"].includes(entry.status)
        && Number.isFinite(entry.endedAt) && entry.endedAt <= now()
        && Number.isFinite(entry.startedAt) && entry.endedAt >= entry.startedAt
        && typeof entry.lastRunId === "string" && entry.lastRunId.length > 0
        && (!entry.activeWriterRunId || entry.activeWriterRunId === entry.lastRunId);
      sessions.push({ key, status: terminal ? entry.status : "unknown",
        hasActiveRun: terminal ? false : true,
        activeRunIds: terminal ? [] : [entry.activeWriterRunId].filter(Boolean),
        endedAt: terminal ? entry.endedAt : undefined,
        lastRunId: terminal ? entry.lastRunId : undefined });
    }
    const ts = now();
    return { ts, sessions: sessions.map(session => ({ ...session, snapshotAt: ts })),
      hasMore: offset + selected.length < keys.length,
      nextOffset: offset + selected.length < keys.length ? offset + selected.length : null };
  };
}
