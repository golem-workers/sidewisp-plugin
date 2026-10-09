import path from 'node:path';
import { watch } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

const MAX_BYTES = 2 * 1024 * 1024;
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max) => typeof value === 'string' ? value.replace(/[\p{C}]/gu, '').trim().slice(0, max) : '';
export function normalizeCronJob(job) {
  if (!job || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id ?? '')) throw new Error('invalid_cron_job');
  const schedule = job.schedule;
  if (!schedule || !['cron', 'every', 'at'].includes(schedule.kind)) throw new Error('invalid_cron_schedule');
  const expression = schedule.kind === 'cron' ? text(schedule.expr, 120)
    : schedule.kind === 'every' && Number.isSafeInteger(schedule.everyMs) && schedule.everyMs > 0 ? String(schedule.everyMs)
    : schedule.kind === 'at' && Number.isFinite(Date.parse(schedule.at)) ? new Date(schedule.at).toISOString() : '';
  if (!expression) throw new Error('invalid_cron_schedule');
  const name = text(job.name, 120);
  // The monitor needs metadata only, never prompts, commands or delivery targets.
  const displayName = /bearer\s|(?:token|secret|password|api.?key)\s*[:=]|sk-[A-Za-z0-9]/i.test(name) ? 'Cron job' : name || 'Cron job';
  const timezone = schedule.kind === 'cron' ? text(schedule.tz, 80) || Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('invalid_cron_timezone'); }
  return { id: job.id, displayName, enabled: job.enabled !== false, kind: schedule.kind, expression, timezone,
    payloadKind: ['agentTurn', 'systemEvent'].includes(job.payload?.kind) ? job.payload.kind : 'unknown',
    createdAtMs: time(job.createdAtMs), nextRunAtMs: time(job.state?.nextRunAtMs), lastRunAtMs: time(job.state?.lastRunAtMs),
    lastStatus: ['ok', 'error', 'skipped'].includes(job.state?.lastRunStatus ?? job.state?.lastStatus) ? job.state.lastRunStatus ?? job.state.lastStatus : 'unknown' };
}
// SQLite is authoritative when present. Never fall back to stale JSON on an error.
// Read a single partition, including runtime state, without initializing or repairing it.
export async function collectOpenClawCron({ stateDir, storePath = path.join(stateDir, 'cron', 'jobs.json'), readFileImpl = readFile, statImpl = stat, sqliteStatImpl = stat }) {
  let db;
  try {
    const target = path.join(stateDir, 'state', 'openclaw.sqlite');
    let sqliteExists = false;
    try { await sqliteStatImpl(target); sqliteExists = true; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    let nativeJobs;
    if (sqliteExists) {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(target, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;');
      const rows = db.prepare('SELECT job_id, enabled, job_json, state_json FROM cron_jobs WHERE store_key = ? ORDER BY job_id LIMIT 1001').all(path.resolve(storePath));
      let bytes = 0;
      nativeJobs = rows.map(row => {
        bytes += Buffer.byteLength(row.job_json) + Buffer.byteLength(row.state_json);
        if (bytes > MAX_BYTES) throw new Error('oversized_cron_inventory');
        const job = JSON.parse(row.job_json), state = JSON.parse(row.state_json);
        if (!job || typeof job !== 'object' || !state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid_cron_row');
        return { ...job, id: row.job_id, enabled: row.enabled !== 0, state };
      });
    } else {
      if ((await statImpl(storePath)).size > MAX_BYTES) return { status: 'unavailable', jobs: [] };
      const raw = await readFileImpl(storePath, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES) return { status: 'unavailable', jobs: [] };
      nativeJobs = JSON.parse(raw).jobs;
    }
    if (!Array.isArray(nativeJobs) || nativeJobs.length > 1000) return { status: 'unavailable', jobs: [] };
    const jobs = nativeJobs.map(normalizeCronJob).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) return { status: 'unavailable', jobs: [] };
    return { status: 'ok', jobs };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'unsupported' : 'unavailable', jobs: [] };
  } finally { db?.close(); }
}

// Watch directories, not inodes: SQLite WAL commits and atomic JSON replacements
// both matter. Timer fallback in delivery covers stores created after startup.
export function watchOpenClawCron({ stateDir, storePath = path.join(stateDir, 'cron', 'jobs.json'), onChange, watchImpl = watch, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, closed = false, lastSnapshot = null;
  const refresh = async () => {
    const snapshot = JSON.stringify(await collectOpenClawCron({ stateDir, storePath }));
    if (closed) return;
    if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; onChange(); }
  };
  const watchers = [];
  for (const [directory, names] of [[path.join(stateDir, 'state'), ['openclaw.sqlite', 'openclaw.sqlite-wal', 'openclaw.sqlite-shm']], [path.dirname(storePath), [path.basename(storePath)]]]) {
    try {
      const watcher = watchImpl(directory, { persistent: false }, (_event, filename) => {
        if (filename && !names.includes(String(filename))) return;
        if (timer) clearTimer(timer);
        timer = setTimer(() => { timer = null; void refresh().catch(() => {}); }, 250); timer?.unref?.();
      });
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* Periodic collection remains available. */ }
  }
  return () => { closed = true; if (timer) clearTimer(timer); timer = null; for (const watcher of watchers) watcher.close(); };
}
