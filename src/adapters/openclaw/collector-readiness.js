import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Bind the response to the actual local store without exposing its path.
export async function collectorStateId(stateDir) {
  return crypto.createHash('sha256').update(await fs.realpath(path.resolve(stateDir))).digest('hex');
}

export function createCollectorReadiness({ enabled, endpoint, stateDir, localReady, readGatewayStatus, localVersion }) {
  return async (minimumVersion) => {
    if (!enabled) return false;
    if (await localReady()) return !minimumVersion || versionAtLeast(localVersion, minimumVersion);
    // Tool discovery can instantiate the plugin without starting its services.
    // Ask the serving Gateway; never start a second collector or waive readiness.
    let status;
    try { status = await readGatewayStatus(); }
    catch { throw new Error('collector_status_unavailable'); }
    if (status?.plugin === 'sidewisp' && status.endpoint === endpoint && status.connectionReadiness?.stateId === await collectorStateId(stateDir) && status.connectionReadiness?.activationRequired === true) throw new Error('collector_activation_required');
    return (!minimumVersion || versionAtLeast(status?.version, minimumVersion))
      && status?.plugin === 'sidewisp'
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

export function versionAtLeast(actual, minimum) {
  const parse = value => typeof value === "string" && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value) ? value.split(".").map(Number) : null;
  const a=parse(actual), b=parse(minimum);
  if (!a || !b || ![...a,...b].every(Number.isSafeInteger)) return false;
  for(let i=0;i<3;i++) if(a[i]!==b[i]) return a[i]>b[i];
  return true;
}
