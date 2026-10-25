// Active-time AbortSignal.timeout alone can retain a pre-sleep socket after
// resume. Recheck wall time on each bounded tick; never change host state.
export function createTransportDeadline({ timeoutMs, signal, now = Date.now,
 setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, resolutionMs = 1000 }) {
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(resolutionMs) || resolutionMs <= 0) throw Error('INVALID_TRANSPORT_DEADLINE');
 const controller = new AbortController();
 let expires = now() + timeoutMs;
 const abort = () => controller.abort(signal?.reason);
 if (signal?.aborted) abort();
 else signal?.addEventListener('abort', abort, {once:true});
 const timer = setIntervalImpl(() => {
  if (now() >= expires) controller.abort(new DOMException('Transport deadline exceeded', 'TimeoutError'));
 }, Math.min(timeoutMs, resolutionMs));
 return Object.freeze({
  signal: controller.signal,
  reset(nextTimeoutMs = timeoutMs) { expires = now() + nextTimeoutMs; },
  close() { clearIntervalImpl(timer); signal?.removeEventListener('abort', abort); controller.abort(); },
 });
}
