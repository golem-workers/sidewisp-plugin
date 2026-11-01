import { createHash } from 'node:crypto';

// Evidence pinned to OpenClaw + bundled memory-core 2026.9.8 (fc23bc8).
// Do not broaden this version allowlist without inspecting its native creators
// and reserved-namespace guard. A missing/new runtime version retains all jobs.
const VERIFIED_RUNTIME = '2026.9.8';
const MEMORY_MARKER_SHA256 = 'f4c56c255003f1aba04bf11274ec6418e555943f4aa38a3da9183e3cf5d5e586';
const result = kind => ({ kind, ruleVersion: 1 });
const agentSuffix = (job, prefix) => {
  if (typeof job.declarationKey !== 'string' || !job.declarationKey.startsWith(prefix)) return false;
  const suffix = job.declarationKey.slice(prefix.length);
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(suffix)
    && (job.agentId === undefined || job.agentId === suffix)
    && (job.owner?.agentId === undefined || job.owner.agentId === suffix);
};
export function classifyOpenClawCron(job, runtimeVersion) {
  if (runtimeVersion !== VERIFIED_RUNTIME || !job || typeof job !== 'object') return result('unknown');
  // Conflicting creator evidence must not be hidden by a declaration alone.
  if (job.createdActor !== undefined && job.createdActor?.type !== 'system') return result('unknown');
  if (job.declarationKey === 'memory-core:memory-dreaming-promotion'
    && job.payload?.kind === 'agentTurn' && typeof job.payload.message === 'string'
    && createHash('sha256').update(job.payload.message).digest('hex') === MEMORY_MARKER_SHA256
    && job.payload.lightContext === true && job.sessionTarget === 'isolated'
    && job.schedule?.kind === 'cron' && job.wakeMode === 'now' && job.delivery?.mode === 'none') return result('memory-dreaming');
  if (agentSuffix(job, 'heartbeat:') && job.payload?.kind === 'heartbeat') return result('heartbeat-monitor');
  if (agentSuffix(job, 'skill-collection-review:')) return result('skill-collection-review');
  return result('unknown');
}
