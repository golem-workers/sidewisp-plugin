import { randomBytes } from 'node:crypto';
import { signBatch } from '../delivery/uploader.js';

export async function inspectCredential({ endpoint, credential, fetchImpl = globalThis.fetch }) {
  if (!credential) return 'unconfigured';
  const body = Buffer.from('{"schema":"sidewisp.credential-status.v1"}');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('base64url');
  const signature = signBatch({ secret: credential.secret, timestamp, nonce, body });
  const response = await fetchImpl(new URL('/v1/installations/credential-status', endpoint), {
    method: 'POST', redirect: 'error', body, signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', authorization: `Sidewisp ${credential.installationId}:${signature}`,
      'x-sidewisp-algorithm': 'hmac-sha256-v1', 'x-sidewisp-timestamp': timestamp, 'x-sidewisp-nonce': nonce },
  });
  const result = await response.json();
  if (result.schema === 'sidewisp.credential-status.v1') {
    if (response.status === 200 && result.status === 'active' && result.installationId === credential.installationId) return 'active';
    if (response.status === 401 && result.status === 'rejected') return 'rejected';
  }
  throw new Error('installation_status_unavailable');
}
