import { isRetainedWork } from '../update/hot-update.js';
// Host-authorized operations are injected by the CLI; no policy fallback here.
export async function prepareConnection({ targetVersion, endpoint, updateOnly = false, inspect, install, upgrade, activate, begin, persist, ensureManager = async () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxReadinessAttempts = 60, maxIdleAttempts = 120, expiresAtMs, now = Date.now }) {
  if (!Number.isInteger(maxReadinessAttempts) || maxReadinessAttempts < 1) throw new Error('invalid_readiness_attempts');
  const mark = async (stage, extra = {}) => persist({ stage, ...extra });
  const checkExpiry = () => {
    if (!updateOnly && expiresAtMs !== undefined && (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now())) throw new Error('fresh_invitation_required');
  };
  if (!Number.isInteger(maxIdleAttempts) || maxIdleAttempts < 1) throw new Error('invalid_idle_attempts');
  const whenIdle = async operation => {
    for (let attempt = 0; attempt < maxIdleAttempts; attempt++) {
      checkExpiry();
      try { return await operation(); } catch (error) {
        if (!isRetainedWork(error) || attempt + 1 === maxIdleAttempts) throw error;
        await mark('waiting_for_host_idle', { attempt: attempt + 1 });
        await sleep(1000);
      }
    }
  };
  const matches = value => value?.version === targetVersion && value.enabled === true && value.running === true && value.connectionReadiness?.ready === true;
  try {
    checkExpiry();
    await mark('inspecting');
    const original = await inspect(); // null means confirmed absence, never a failed read
    if (original && original.endpoint !== endpoint) throw new Error('existing_endpoint_mismatch');
    if (!original && updateOnly) throw new Error('existing_plugin_required');
    if (!original) {
      await mark('installing');
      await whenIdle(install);
      await mark('activating');
      await whenIdle(activate);
    } else if (original.version !== targetVersion) {
      await mark('upgrading');
      await upgrade();
    }
    await mark('verifying');
    let ready;
    for (let attempt = 0; attempt < maxReadinessAttempts; attempt++) {
      checkExpiry();
      ready = await inspect(); // Refusal/transport errors never authorize mutation.
      if (ready && ready.endpoint !== endpoint) throw new Error('existing_endpoint_mismatch');
      if (original?.installation?.installationId !== undefined && ready?.installation?.installationId !== original.installation.installationId) throw new Error('existing_binding_changed');
      if (matches(ready)) break;
      if (attempt + 1 === maxReadinessAttempts) throw new Error('collector_not_ready');
      await mark('waiting_for_readiness', { attempt: attempt + 1 });
      await sleep(1000);
    }
    if (!matches(ready)) throw new Error('collector_not_ready');
    await ensureManager();
    if (updateOnly) { await mark('completed', { bindingPreserved: true }); return { status: 'completed' }; }
    checkExpiry();
    await mark('requesting_approval');
    const result = await begin(); // binding checks/proof remain inside authorization client
    await mark('approval_pending', { requestId: result.id, expiresAtMs: result.expiresAtMs });
    return { status: 'approval_pending', requestId: result.id, expiresAtMs: result.expiresAtMs };
  } catch (error) {
    const reason = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'preparation_failed';
    await mark('blocked', { reason });
    throw error;
  }
}
