import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Bind the response to the actual local store without exposing its path.
export async function collectorStateId(stateDir) {
  return crypto.createHash('sha256').update(await fs.realpath(path.resolve(stateDir))).digest('hex');
}

export function createCollectorReadiness({ enabled, endpoint, stateDir, localReady, readGatewayStatus }) {
  return async () => {
    if (!enabled) return false;
    if (await localReady()) return true;
    // Tool discovery can instantiate the plugin without starting its services.
    // Ask the serving Gateway; never start a second collector or waive readiness.
    let status;
    try { status = await readGatewayStatus(); }
    catch { throw new Error('collector_status_unavailable'); }
    return status?.plugin === 'sidewisp'
      && status.endpoint === endpoint
      && status.enabled === true && status.running === true
      && status.connectionReadiness?.ready === true
      && status.connectionReadiness?.stateId === await collectorStateId(stateDir);
  };
}

export async function readServingCollectorStatus() {
  // The privileged in-process gateway runtime is reserved for trusted official
  // plugins. Sidewisp uses the public authenticated read-only SDK transport.
  // Standalone tool hosts have no in-process Gateway. Use the SDK's authenticated,
  // configured transport, read-only and without credentials in arguments/output.
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  return callGatewayFromCli('sidewisp.status', { json: true, timeout: '10000' }, {},
    { progress: false, scopes: ['operator.read'], sharedStateMode: 'read-only' });
}
