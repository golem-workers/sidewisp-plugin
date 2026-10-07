// Published 2026.9.8 binds hot-started services to the installer RPC lifetime.
// On this exact SDK, only process bootstrap passes the public startupTrace
// service context. gateway_start is also replayed on hot replacement and is NOT proof.
export function createActivationReadiness(runtimeVersion) {
  let coldStarted = false;
  const affected = runtimeVersion === '2026.9.8';
  return {
    serviceStarted(context) { coldStarted = typeof context?.startupTrace?.measure === 'function'; },
    required() { return affected && !coldStarted; },
  };
}
