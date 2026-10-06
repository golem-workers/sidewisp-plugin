// A timed-out operation retains its flight until it settles: never overlap it.
export function createHeartbeatSupervisor({ run, intervalMs = 30000, retryMs = 5000, timeoutMs = 15000, maxFailures = 3, permanent = () => false, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let stopped = true, timer = null, flight = null, failures = 0, state = 'stopped', generation = 0, controller = null, healthy = false;
  const schedule = (ms, epoch) => {
    if (stopped || epoch !== generation) return;
    timer = setTimer(() => { timer = null; void tick(epoch); }, ms); timer?.unref?.();
  };
  async function tick(epoch) {
    if (stopped || epoch !== generation || flight) return;
    state = 'checking';
    let deadline;
    controller = new AbortController();
    const operation = Promise.resolve().then(() => run(controller.signal));
    flight = operation;
    deadline = setTimer(() => { if (!stopped && epoch === generation) { state = 'timed-out'; healthy = false; } }, timeoutMs);
    deadline?.unref?.();
    try {
      await operation;
      if (stopped || epoch !== generation) return;
      failures = 0; healthy = true; state = 'ready'; schedule(intervalMs, epoch);
    } catch (error) {
      if (stopped || epoch !== generation) return;
      failures++; healthy = false; try { onError(error); } catch { /* reporting must not terminate supervision */ }
      if (permanent(error)) state = 'blocked';
      else if (failures >= maxFailures) state = 'failed';
      else { state = 'recovering'; schedule(retryMs, epoch); }
    } finally {
      clearTimer(deadline); flight = null;
      // Timeout marks unknown, never spawns concurrent replacement work.

    }
  }
  return {
    start() { if (!stopped || flight) return; stopped = false; healthy = false; failures = 0; generation++; void tick(generation); },
    async stop() { stopped = true; generation++; state = 'stopped'; if (timer) clearTimer(timer); timer = null; controller?.abort(); if (flight) { let deadline; await Promise.race([flight.catch(() => {}),new Promise(resolve => { deadline = setTimer(resolve, 1000); })]); clearTimer(deadline); } },
    ready: () => !stopped && healthy && ['ready','checking'].includes(state),
    status: () => ({ state, failures, inFlight: Boolean(flight) }),
  };
}
export function permanentHeartbeatFailure(error) {
  return [401,403].includes(error?.status ?? error?.statusCode)
    || /permission|forbidden|unauthorized|credential.rejected|invalid.device.proof|spool/i.test(String(error?.code ?? error?.message ?? ''));
}
