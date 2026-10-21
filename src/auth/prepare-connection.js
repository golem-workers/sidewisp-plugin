import { isRetainedWork } from '../update/hot-update.js';
// Host-authorized operations are injected by the CLI; no policy fallback here.
export async function prepareConnection({ targetVersion, endpoint, updateOnly = false, inspect, install, upgrade, activate, coldActivate, begin, persist, ensureManager = async () => {}, prepareRuntime, finalizeRuntime = async () => {}, runtimeNeedsActivation = async () => true, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxReadinessAttempts = 60, maxIdleAttempts = 3600, expiresAtMs, now = Date.now }) {
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
        if (!(isRetainedWork(error) || ['host_activation_busy','update_deferred'].includes(error?.message))) throw error;
        if (attempt + 1 === maxIdleAttempts) throw new Error('host_idle_timeout');
        await mark('waiting_for_host_idle', { reasonCode: error?.reasonCode ?? 'HOST_RETAINED_WORK', attempt: attempt + 1 });
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
    let runtimePrepared;
    if (prepareRuntime) { await mark('preparing_runtime'); runtimePrepared = await whenIdle(prepareRuntime); }
    if (!original) {
      await mark('installing');
      await whenIdle(install);
      await mark('activating');
      await whenIdle(activate);
    } else if (original.version !== targetVersion) {
      await mark('upgrading');
      await whenIdle(upgrade);
    }
    if ((runtimePrepared?.activationRequired ?? runtimePrepared?.changed) && await runtimeNeedsActivation(runtimePrepared)) {
      if (typeof coldActivate !== 'function') throw Error('cold_activation_required');
      await mark('activating_runtime'); await whenIdle(coldActivate);
    }
    await mark('verifying');
    let ready;
    let coldActivated = false;
    for (let attempt = 0; attempt < maxReadinessAttempts; attempt++) {
      checkExpiry();
      ready = await inspect(); // Refusal/transport errors never authorize mutation.
      if (ready && ready.endpoint !== endpoint) throw new Error('existing_endpoint_mismatch');
      if (original?.installation?.installationId !== undefined && ready?.installation?.installationId !== original.installation.installationId) throw new Error('existing_binding_changed');
      if (ready?.version === targetVersion && ready.connectionReadiness?.activationRequired === true && !coldActivated) {
        await mark('activating');
        if (typeof coldActivate !== 'function') throw new Error('cold_activation_required');
        await whenIdle(coldActivate);
        coldActivated = true;
        ready = await inspect();
        if (ready?.endpoint !== endpoint || (original?.installation?.installationId !== undefined && ready?.installation?.installationId !== original.installation.installationId)) throw new Error('existing_binding_changed');
      }
      if (matches(ready)) break;
      if (attempt + 1 === maxReadinessAttempts) throw new Error('collector_not_ready');
      await mark('waiting_for_readiness', { attempt: attempt + 1 });
      await sleep(1000);
    }
    if (!matches(ready)) throw new Error('collector_not_ready');
    await ensureManager();
    if (runtimePrepared) await finalizeRuntime(runtimePrepared);
    if (updateOnly) { await mark('completed', { bindingPreserved: true }); return { status: 'completed' }; }
    checkExpiry();
    await mark('requesting_approval');
    const result = await begin(); // binding checks/proof remain inside authorization client
    const status = result.autoConnect ? 'connection_pending' : 'approval_pending';
    await mark(status, { requestId: result.id, expiresAtMs: result.expiresAtMs });
    return { status, requestId: result.id, expiresAtMs: result.expiresAtMs };
  } catch (error) {
    const reason = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'preparation_failed';
    await mark('blocked', { reason });
    throw error;
  }
}
