// Retry failed initialization, never change permissions, credentials or owner policy.
// Broken schemas, corrupt state, auth refusals and unknown programming errors
// require diagnosis rather than an unbounded restart loop.
export function retryableCollectorStartupFailure(error) {
  if ([401,403].includes(error?.status ?? error?.statusCode)) return false;
  return ['locked', 'EACCES', 'EPERM', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOSPC', 'EIO',
    'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(error?.code);
}
export function collectorStartupRetryDelay(failures) {
  return Math.min(60000, 5000 * 2 ** Math.min(failures, 4));
}
