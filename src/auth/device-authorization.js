import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createFileCredentialStore } from './credentials.js';
import { inspectCredential } from './credential-status.js';

// CLI output contains only public request details. Device proof and credentials stay on disk.
export function createDeviceAuthorizationClient({ endpoint, stateDir, fetchImpl = globalThis.fetch }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_device_endpoint');
  if (!path.isAbsolute(stateDir)) throw new Error('absolute_state_directory_required');
  const directory = path.join(stateDir, 'sidewisp');
  const file = path.join(directory, 'device-authorization.json');
  const credentials = createFileCredentialStore({ stateDir });
  const request = async (route, input) => {
    const response = await fetchImpl(new URL(route, url), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`device_authorization_http_${response.status}`);
    return response.json();
  };
  const read = async () => {
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    if (row.endpoint !== url.origin || !/^sw_pair_[A-Za-z0-9_-]{32}$/.test(row.id)
      || !/^sw_device_[A-Za-z0-9_-]{43}$/.test(row.deviceSecret)) throw new Error('invalid_device_state');
    return row;
  };
  return {
    async status() {
      return { status: await inspectCredential({ endpoint: url, credential: await credentials.read(), fetchImpl }) };
    },
    async begin({ id, runtime }) {
      if (!/^sw_pair_[A-Za-z0-9_-]{32}$/.test(id) || !['openclaw','hermes'].includes(runtime)) throw new Error('invalid_device_request');
      // Replacing a working installation is a distinct, explicit reconnect operation.
      const existing = await credentials.read();
      if (existing && await inspectCredential({ endpoint: url, credential: existing, fetchImpl }) === 'active') throw new Error('installation_already_connected');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      let state;
      try { state = await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state && (state.id !== id || state.runtime !== runtime)) {
        const previous = await request('/v1/device-authorizations/poll', { id: state.id, deviceSecret: state.deviceSecret });
        if (!['expired', 'denied', 'completed'].includes(previous.status)) throw new Error('another_authorization_pending');
        await fs.rm(file);
        state = null;
      }
      if (!state) {
        state = { id, runtime, endpoint: url.origin, deviceSecret: `sw_device_${randomBytes(32).toString('base64url')}` };
        await fs.writeFile(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      }
      const result = await request('/v1/device-authorizations/begin', { id, runtime, deviceSecret: state.deviceSecret });
      if (result.id !== id || !/^[A-F0-9]{10}$/.test(result.userCode ?? '')) throw new Error('invalid_device_response');
      return { status: 'pending', id, userCode: result.userCode, expiresAtMs: result.expiresAtMs,
        verificationUri: `${url.origin}/device-authorization?id=${encodeURIComponent(id)}&code=${result.userCode}` };
    },
    async poll() {
      const state = await read();
      const input = { id: state.id, deviceSecret: state.deviceSecret };
      const result = await request('/v1/device-authorizations/poll', input);
      if (result.status === 'approved') {
        const credential = result.credential;
        const existing = await credentials.read();
        if (existing && existing.installationId !== credential?.installationId
          && await inspectCredential({ endpoint: url, credential: existing, fetchImpl }) === 'active') throw new Error('installation_already_connected');
        await credentials.write({ installationId: credential?.installationId, secret: credential?.installationSecret, status: 'active' });
        await request('/v1/device-authorizations/poll', { ...input, acknowledge: true });
        await fs.rm(file);
        return { status: 'credential_saved', installationId: credential.installationId };
      }
      if (result.status === 'completed') {
        const existing = await credentials.read();
        if (!existing || existing.status !== 'active') throw new Error('device_ack_without_credential');
        await fs.rm(file);
        return { status: 'credential_saved', installationId: existing.installationId };
      }
      if (['denied','expired'].includes(result.status)) await fs.rm(file);
      if (!['pending','denied','expired','completed'].includes(result.status)) throw new Error('invalid_device_response');
      return { status: result.status };
    },
  };
}
