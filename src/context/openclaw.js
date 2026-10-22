import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Read session metadata only: never transcripts, prompts, names or channel IDs.
// One most recently updated non-archived root session, never cumulative usage.
export async function collectOpenClawContext({ stateDir, now = Date.now } = {}) {
  const root = path.join(stateDir, 'agents');
  const agents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const agent of agents.filter(x => x.isDirectory()).slice(0, 100)) {
    const dbPath = path.join(root, agent.name, 'agent', 'openclaw-agent.sqlite');
    let db;
    try {
      await fs.access(dbPath);
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare(`SELECT entry_json, updated_at FROM session_nodes
        WHERE entry_valid=1 AND archived_at IS NULL AND parent_session_key IS NULL
        ORDER BY updated_at DESC LIMIT 1`).get();
      if (row) rows.push({ entry: JSON.parse(row.entry_json), updatedAt: row.updated_at });
    } catch {
      // Legacy OpenClaw uses the standard session index.
      try {
        const file = path.join(root, agent.name, 'sessions', 'sessions.json');
        if ((await fs.stat(file)).size > 2 * 1024 * 1024) continue;
        const entries = JSON.parse(await fs.readFile(file, 'utf8'));
        const latest = Object.entries(entries).filter(([key, e]) => !key.includes(':subagent:') && !key.includes(':cron:') && !e?.archivedAt)
          .map(([, entry]) => ({ entry, updatedAt: entry.updatedAt })).sort((a,b) => b.updatedAt-a.updatedAt)[0];
        if (latest) rows.push(latest);
      } catch { /* Unsupported/missing metadata is unknown, never zero. */ }
    } finally { db?.close(); }
  }
  const latest = rows.sort((a,b) => b.updatedAt-a.updatedAt)[0];
  if (!latest) return [];
  const { entry, updatedAt } = latest;
  const used = entry.totalTokens, limit = entry.contextTokens;
  if (entry.totalTokensFresh === false || !Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0
    || !Number.isSafeInteger(updatedAt) || updatedAt > now()) return [];
  const fact = (key, value, unit='count') => ({ key, value, unit, status:'ok', severity:'info', source:'session-metadata' });
  return [fact('context.used', used), fact('context.capacity', limit), fact('context.measured_at_ms', updatedAt, 'milliseconds'),
    fact('context.selection', 'latest_root_session', 'selection')];
}
