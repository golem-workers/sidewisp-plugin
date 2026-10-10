import crypto from 'node:crypto';
import { signBatch } from './uploader.js';

// A local zero-LLM timer, not a new agent cron job. One bounded flight at a time.
export function createCronDelivery({ collect, credentialProvider, endpoint, fetchImpl = globalThis.fetch,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 30000, subscribe = () => () => {} }) {
  let timer = null, running = null, stopped = true, unsubscribe = null, dirty = false;
  let last = { status: 'not-started', at: null };
  const finish = status => (last = { status, at: new Date(now()).toISOString() });
  async function execute() {
    try {
      const credential = await credentialProvider.current();
      if (!credential || credential.status !== 'active') return finish('disabled');
      const result = await collect();
      const observedAtMs = now();
      const sample = { schema: 'sidewisp.cron-snapshot.v1', installationId: credential.installationId, observedAtMs, ...result };
      const body = Buffer.from(JSON.stringify(sample)), timestamp = Math.floor(observedAtMs / 1000).toString(), nonce = crypto.randomBytes(16).toString('base64url');
      const signature = signBatch({ secret: credential.secret, timestamp, nonce, body });
      const response = await fetchImpl(new URL('/v1/cron/snapshots', endpoint), { method: 'POST', body, signal: AbortSignal.timeout(10000), headers: {
        'content-type': 'application/json', authorization: `Sidewisp ${credential.installationId}:${signature}`,
        'x-sidewisp-algorithm': 'hmac-sha256-v1', 'x-sidewisp-timestamp': timestamp, 'x-sidewisp-nonce': nonce } });
      if (!response.ok) return finish([401, 403].includes(response.status) ? 'credential-rejected' : 'retry');
      const ack = await response.json();
      return finish(ack.schema === 'sidewisp.cron-ack.v1' && ack.observedAtMs === observedAtMs ? 'sent' : 'invalid-ack');
    } catch { return finish('retry'); }
  }
  async function cycle() { let result; do { dirty = false; result = await execute(); } while (dirty && !stopped); return result; }
  function run() { if (running) return running; running = cycle().finally(() => { running = null; }); return running; }
  function refresh() { if (stopped) return; dirty = true; void run().catch(() => {}); }
  function tick() { if (stopped) return; void run().finally(() => { if (!stopped) { timer = setTimer(tick, intervalMs); timer?.unref?.(); } }); }
  return Object.freeze({ run, status: () => ({ ...last }), start() { if (!stopped) return; stopped = false; unsubscribe = subscribe(refresh); tick(); },
    async stop() { stopped = true; unsubscribe?.(); unsubscribe = null; if (timer) clearTimer(timer); timer = null; if (running) await running; } });
}
