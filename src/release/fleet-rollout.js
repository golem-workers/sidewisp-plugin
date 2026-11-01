import { isNewerVersion } from '../update/directive.js';

const terminalFailures = new Set(['failed', 'rolled_back', 'rolling_back']);
const cohort = (agent) => `${agent.runtime}/${agent.version}/${agent.runtimeVersion}`;

// Pure decision engine. A controller must persist nextState before applying the
// exact allowlist, keep rolloutPercent=0, and serialize each environment's tick.
export function planFleetRollout({ release, environment, agents, state = null, now = Date.now() }) {
  if (!release || !/^\d+\.\d+\.\d+$/.test(release.version)
    || !/^[a-f0-9]{40}$/.test(release.commit ?? '')
    || !/^[a-f0-9]{64}$/.test(release.sha256 ?? '')
    || !release.environments?.includes(environment)
    || !Array.isArray(release.verifiedMigrations)
    || !Number.isFinite(now)) throw new Error('INVALID_VERIFIED_RELEASE');
  const fingerprint = `${environment}/${release.version}/${release.commit}/${release.sha256}`;
  if (state && state.fingerprint !== fingerprint) throw new Error('RELEASE_CHANGE_REQUIRES_NEW_STATE');
  if (new Set(agents.map(a => a.id)).size !== agents.length) throw new Error('DUPLICATE_INSTALLATION');
  const next = structuredClone(state ?? { fingerprint, phase: 'canary', attempts: {}, provenCohorts: [], halted: null });
  const fresh = a => Number.isFinite(a.lastSeen) && a.lastSeen <= now && now - a.lastSeen <= 120_000;
  const eligible = a => !a.quarantined && a.diagnosticsSupported !== false && a.status === 'active' && a.credentialActive === true && fresh(a)
    && release.verifiedMigrations.includes(cohort(a)) && isNewerVersion(release.version, a.version);
  const observations = [];
  for (const a of agents) {
    const attempt = next.attempts[a.id];
    const d = a.update;
    if (attempt?.completed && fresh(a) && a.version !== release.version) {
      next.halted ??= { id: a.id, reason: 'version_regressed' };
    }
    // Never mistake an old diagnostic or a previous release's outcome for this attempt.
    const correlated = attempt && d && d.observedAt >= attempt.startedAt
      && d.observedAt <= now && d.attemptAt >= attempt.startedAt
      && d.attemptAt <= d.observedAt;
    if (correlated && (terminalFailures.has(d.status) || d.status === 'skipped')) next.halted ??= { id: a.id, reason: d.status };
    if (attempt && !attempt.completed && now - attempt.startedAt > 3_600_000) next.halted ??= { id: a.id, reason: 'attempt_timeout' };
    if (correlated && d.status === 'completed' && a.version === release.version
      && fresh(a) && a.credentialActive === true && now - attempt.startedAt >= 120_000) {
      attempt.completed = true;
      if (!next.provenCohorts.includes(attempt.cohort)) next.provenCohorts.push(attempt.cohort);
    }
    const reason = a.quarantined ? 'recovery_required' : a.status !== 'active' ? a.status
      : !a.credentialActive ? 'credential_unavailable'
      : !fresh(a) ? 'offline'
      : attempt?.completed ? 'completed'
      : a.version === release.version ? 'version_reported_unverified'
      : a.diagnosticsSupported === false ? 'backend_diagnostics_unavailable'
      : !release.verifiedMigrations.includes(cohort(a)) ? 'migration_unverified'
      : attempt ? 'pending' : 'eligible';
    observations.push({ id: a.id, reason });
  }
  // Disappearance/deletion/revocation of a running canary is not a success.
  for (const [id, attempt] of Object.entries(next.attempts)) {
    if (!attempt.completed && !agents.some(a => a.id === id && a.status === 'active' && a.credentialActive)) {
      next.halted ??= { id, reason: 'installation_unavailable' };
    }
  }
  if (!next.halted) {
    for (const a of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!eligible(a) || next.attempts[a.id]) continue;
      const key = cohort(a);
      const proven = next.provenCohorts.includes(key);
      if (!proven && Object.values(next.attempts).some(x => x.cohort === key)) continue;
      next.attempts[a.id] = { cohort: key, startedAt: now, completed: false };
    }
  }
  next.phase = next.halted ? 'halted' : next.provenCohorts.length ? 'rolling' : 'canary';
  const allowlist = next.halted ? [] : agents.filter(a => !a.quarantined && a.status === 'active' && a.credentialActive
    && fresh(a) && next.attempts[a.id] && !next.attempts[a.id].completed).map(a => a.id).sort();
  return { nextState: next, policy: { version: release.version,
    spec: `git:github.com/golem-workers/sidewisp-plugin@v${release.version}`,
    sha256: release.sha256, rolloutPercent: 0, allowlist }, observations };
}
