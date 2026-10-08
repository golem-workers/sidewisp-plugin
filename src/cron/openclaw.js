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
export async function collectOpenClawCron({ stateDir, readFileImpl = readFile, statImpl = stat }) {
  try {
    const target = path.join(stateDir, 'cron', 'jobs.json');
    if ((await statImpl(target)).size > MAX_BYTES) return { status: 'unavailable', jobs: [] };
    const raw = await readFileImpl(target, 'utf8');
    if (Buffer.byteLength(raw) > MAX_BYTES) return { status: 'unavailable', jobs: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.jobs) || data.jobs.length > 1000) return { status: 'unavailable', jobs: [] };
    const jobs = data.jobs.map(normalizeCronJob).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) return { status: 'unavailable', jobs: [] };
    return { status: 'ok', jobs };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'unsupported' : 'unavailable', jobs: [] };
  }
}

// Watch the containing directory so atomic jobs.json replacements stay observable.
// Filesystem watching is supplementary; unsupported/missing stores retain timer fallback.
export function watchOpenClawCron({ stateDir, onChange, watchImpl = watch, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, watcher = null;
  try {
    watcher = watchImpl(path.join(stateDir, 'cron'), { persistent: false }, (_event, filename) => {
      if (filename && String(filename) !== 'jobs.json') return;
      if (timer) clearTimer(timer);
      timer = setTimer(() => { timer = null; onChange(); }, 50); timer?.unref?.();
    });
    watcher.on('error', () => { watcher?.close(); watcher = null; });
  } catch { /* Timer fallback also handles a cron store created after startup. */ }
  return () => { if (timer) clearTimer(timer); timer = null; watcher?.close(); watcher = null; };
}
