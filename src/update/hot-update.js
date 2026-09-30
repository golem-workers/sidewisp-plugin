// Only the host decides whether a plugin generation can be replaced. In particular,
// the setup conversation itself can retain it. Busy is deferral, never rollback.
export function isRetainedWork(error) {
  const text = [error?.message, error?.stderr, error?.stdout].map(v => String(v ?? '')).join('\n');
  return /still has active retained work; retry after the work finishes\.|cannot replace itself from its own active call; retry after the call finishes\./.test(text);
}
export function isTaskIdle(status) {
  const tasks = status?.userTasks;
  return Boolean(tasks && ['activeRuns', 'pendingTerminals', 'awaitingFinals', 'pendingInboundObservations']
    .every(key => tasks[key] === 0));
}
export async function applyHotUpdate({ targetVersion, install, reload, status, writeState,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxAttempts = 120, alreadyStaged = false, verify = () => {} }) {
  let staged = alreadyStaged;
  let applied = false;
  let unhealthyObservations = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await status(); // Authentication/transport failures are not idle.
    if (current?.version === targetVersion) {
      if (current.enabled !== true || current.running !== true || current.connectionReadiness?.ready !== true) {
        if (++unhealthyObservations >= 12) throw new Error('TARGET_COLLECTOR_UNHEALTHY');
        writeState({status:'verifying',reasonCode:'WAITING_FOR_COLLECTOR'});
        await sleep(5000);
        continue;
      }
      await verify(current);
      writeState({ status: 'completed' });
      return;
    }
    if (current && !isTaskIdle(current)) {
      writeState({ status: 'waiting_for_idle', reasonCode: 'ACTIVE_WORK' });
      await sleep(5000);
      continue;
    }
    try {
      if (!staged) {
        writeState({ status: 'updating' });
        // The CLI may commit files before rejecting replacement. Never reinstall
        // on that specific result: reload the persisted generation when idle.
        try { await install(); } catch (error) {
          if (!isRetainedWork(error)) throw error;
          staged = true;
          writeState({ status: 'waiting_for_idle', reasonCode: 'HOST_RETAINED_WORK' });
          await sleep(5000);
          continue;
        }
        staged = true;
      }
      if (!applied) {
        const loaded = await status();
        if (loaded?.version !== targetVersion) await reload();
        applied = true;
      }
      writeState({ status: 'verifying' });
      await sleep(5000);
    } catch (error) {
      if (!isRetainedWork(error)) throw error;
      writeState({ status: 'waiting_for_idle', reasonCode: 'HOST_RETAINED_WORK' });
      await sleep(5000);
    }
  }
  writeState({ status: 'deferred', reasonCode: 'IDLE_WINDOW_TIMEOUT' });
}
