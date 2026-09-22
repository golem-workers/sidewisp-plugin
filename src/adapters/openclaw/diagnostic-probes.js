import { monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat, statfs } from 'node:fs/promises';
import v8 from 'node:v8';
import { collectOpenClawContext } from '../../context/openclaw.js';

// Only numeric measurements and closed enums leave the host. No shell, network
// scans, config values, exception text, job names, paths or channel identifiers.
const fact = (key, value, unit) => ({ key, value, status: 'ok', severity: 'info', ...(unit ? { unit } : {}), source: 'local-probe' });
const section = (facts) => ({ outcome: 'ok', facts });
const unsupported = () => ({ outcome: 'unsupported', facts: [] });
const percent = (used, total) => total > 0 ? Math.round(Math.max(0, Math.min(100, used / total * 100)) * 10) / 10 : null;
export function createOpenClawDiagnosticProbes({
  stateDir, enrollment = () => false, spool = () => null, uploader = () => null,
  updates = () => null, configuration = () => ({}),
  memoryUsage = () => process.memoryUsage(), heap = () => v8.getHeapStatistics(),
  totalmem = () => os.totalmem(), freemem = () => os.freemem(), cpus = () => os.cpus(),
  eventLoopMonitor = () => monitorEventLoopDelay({resolution:20}),
  contextUsage = () => collectOpenClawContext({ stateDir, now }),
  statfsImpl = statfs, readFileImpl = readFile, statImpl = stat, now = Date.now,
} = {}) {
  let previousCpu = null;
  let loop = null;
  return {
    dispose() { loop?.disable(); loop=null; previousCpu=null; },
    async runtime() {
      const memory = memoryUsage(); const limit = heap().heap_size_limit;
      const facts = [fact('process.alive', true), fact('process.rss_bytes', memory.rss, 'bytes'),
        fact('process.heap_used_percent', percent(memory.heapUsed, limit), 'percent')];
      if(!loop) { loop=eventLoopMonitor(); loop.enable(); }
      else if(loop.count>0 && Number.isFinite(loop.max)) { facts.push(fact('process.event_loop_delay_ms',Math.round(loop.max/1e6),'milliseconds')); loop.reset(); }
      const cpu = cpus().reduce((sum, item) => ({idle:sum.idle + item.times.idle,total:sum.total + Object.values(item.times).reduce((a,b)=>a+b,0)}), {idle:0,total:0});
      if (previousCpu && cpu.total > previousCpu.total && cpu.idle >= previousCpu.idle) {
        facts.push(fact('host.cpu_used_percent', percent(cpu.total - previousCpu.total - (cpu.idle - previousCpu.idle), cpu.total - previousCpu.total), 'percent'));
      }
      previousCpu = cpu;
      // MemAvailable is preferable to MemFree (page cache is reclaimable).
      try {
        const text = await readFileImpl('/proc/meminfo', 'utf8');
        const values = Object.fromEntries([...text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm)].map((m) => [m[1], Number(m[2]) * 1024]));
        if (values.MemTotal > 0 && Number.isFinite(values.MemAvailable)) facts.push(fact('host.memory_available_percent', percent(values.MemAvailable, values.MemTotal), 'percent'));
        if (values.SwapTotal > 0 && Number.isFinite(values.SwapFree)) facts.push(fact('host.swap_used_percent', percent(values.SwapTotal - values.SwapFree, values.SwapTotal), 'percent'));
      } catch { /* Other OSes: free RAM is a measurement, not memory pressure. */ }
      facts.push(fact('host.ram_total_bytes', totalmem(), 'bytes'), fact('host.ram_free_bytes', freemem(), 'bytes'));
      try { facts.push(...await contextUsage()); } catch { /* Context unavailable. */ }
      return section(facts);
    },
    async configuration() {
      const cfg = configuration();
      return section([fact('sidewisp.enrolled', enrollment() === true), fact('runtime.config_readable', cfg !== null && typeof cfg === 'object')]);
    },
    async connectivity() {
      const status = uploader();
      if (!status) return unsupported();
      const allowed = new Set(['idle', 'sent', 'retry', 'disabled', 'credential-rejected', 'rejected', 'backpressure', 'dead-lettered', 'not-started']);
      const deliveredAt = Date.parse(status.lastDeliveredAt ?? '');
      const deliveryProven = Number.isFinite(deliveredAt) && deliveredAt <= now() && now() - deliveredAt <= 900000 && ['idle','sent'].includes(status.status);
      const facts = [fact('sidewisp.delivery_state', deliveryProven ? 'sent' : status.status === 'credential-rejected' ? 'auth_rejected' : allowed.has(status.status) ? status.status : 'unknown')];
      if (Number.isSafeInteger(status.remaining) && status.remaining >= 0) facts.push(fact('sidewisp.queue_remaining', status.remaining, 'count'));
      const codes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'TimeoutError', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);
      if (codes.has(status.transportCode)) facts.push(fact('sidewisp.transport_code', status.transportCode));
      const at = Date.parse(status.at ?? '');
      if (Number.isFinite(at) && at <= now()) facts.push(fact('sidewisp.delivery_age_seconds', Math.floor((now() - at) / 1000), 'seconds'));
      return section(facts);
    },
    async storage() {
      const s = await statfsImpl(stateDir); const facts = [];
      if (s.blocks > 0) {
        facts.push(fact('disk.used_percent', percent(s.blocks - s.bavail, s.blocks), 'percent'));
        facts.push(fact('disk.available_bytes', s.bavail * s.bsize, 'bytes'));
      }
      if (s.files > 0) facts.push(fact('disk.inode_used_percent', percent(s.files - s.ffree, s.files), 'percent'));
      const health = spool();
      if (health) {
        facts.push(fact('sidewisp.spool_state', ['healthy', 'degraded', 'unhealthy'].includes(health.status) ? health.status : 'unknown'));
        if (health.maxBytes > 0) facts.push(fact('sidewisp.spool_used_percent', percent(health.bytes, health.maxBytes), 'percent'));
        if (typeof health.recoveredFromCorruption === 'boolean') facts.push(fact('sidewisp.spool_recovered', health.recoveredFromCorruption));
      }
      return section(facts);
    },
    async scheduler() {
      // Optional standard OpenClaw cron store; absence is unsupported, not healthy.
      const target = path.join(stateDir, 'cron', 'jobs.json');
      try {
        const info = await statImpl(target); if (info.size > 2 * 1024 * 1024) return unsupported();
        const raw = await readFileImpl(target, 'utf8'); if (Buffer.byteLength(raw) > 2 * 1024 * 1024) return unsupported();
        const data = JSON.parse(raw); if (!Array.isArray(data.jobs) || data.jobs.length > 10000) return unsupported();
        const jobs = data.jobs.filter((job) => job && job.enabled === true);
        return section([fact('scheduler.enabled_count', jobs.length, 'count'), fact('scheduler.failed_count', jobs.filter((job) => job.state?.lastStatus === 'error' || job.state?.lastRunStatus === 'error').length, 'count')]);
      } catch (error) { if (error?.code === 'ENOENT') return unsupported(); throw error; }
    },
    async integrations() {
      const cfg = configuration();
      // Inventory only: configuration presence is not proof of channel health.
      const entries = cfg?.plugins?.entries;
      if (!entries || typeof entries !== 'object') return unsupported();
      return section([fact('integrations.configured_count', Object.keys(entries).length, 'count'), fact('integrations.disabled_count', Object.values(entries).filter((item) => item?.enabled === false).length, 'count')]);
    },
    async updates() {
      const update = updates(); if (!update) return unsupported();
      const attempt = update.lastAttempt;
      const allowed = new Set(['completed', 'failed', 'rolled_back', 'skipped', 'updating', 'restarting', 'verifying', 'scheduled']);
      const facts = [fact('update.attempt_state', !attempt ? 'none' : allowed.has(attempt.status) ? attempt.status : 'unknown')];
      const at = Date.parse(attempt?.updatedAt ?? '');
      if (Number.isFinite(at) && at <= now()) facts.push(fact('update.attempt_age_seconds', Math.floor((now() - at) / 1000), 'seconds'));
      return section(facts);
    },
  };
}
