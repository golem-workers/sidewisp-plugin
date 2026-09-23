import { createDeviceAuthorizationClient } from '../../auth/device-authorization.js';

// Endpoint and state directory belong to the host, never to model-supplied input.
export function createConnectTool({ endpoint, stateDir, ready, fetchImpl }) {
  const device = createDeviceAuthorizationClient({ endpoint, stateDir, fetchImpl });
  let busy = false;
  const reply = (details, isError = false) => ({
    content: [{ type: 'text', text: JSON.stringify(details) }], details, isError,
  });
  return {
    name: 'sidewisp_connect',
    label: 'Connect Sidewisp',
    description: 'Request Sidewisp monitoring access using a public invitation ID. The owner must approve in Sidewisp. Credentials stay local; the running collector completes automatically. Does not install plugins or change host configuration. Never report connected until the server receives telemetry.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        requestId: { type: 'string', pattern: '^sw_pair_[A-Za-z0-9_-]{32}$' },
        endpoint: { type: 'string', description: 'Exact Sidewisp origin from the invitation; must match host configuration.' },
      },
      required: ['requestId', 'endpoint'],
    },
    async execute(_callId, input) {
      if (!input || Object.keys(input).some(key => !['requestId', 'endpoint'].includes(key))
        || !/^sw_pair_[A-Za-z0-9_-]{32}$/.test(input.requestId ?? '')
        || input.endpoint !== new URL(endpoint).origin) {
        return reply({ status: 'blocked', reason: 'invalid_invitation_or_endpoint' }, true);
      }
      if (busy) return reply({ status: 'blocked', reason: 'connection_request_in_progress' }, true);
      busy = true;
      try {
        if (!await ready()) return reply({ status: 'blocked', reason: 'collector_not_ready' }, true);
        const result = await device.begin({ id: input.requestId, runtime: 'openclaw' });
        // Do not return fallback verification URL/code even in a private session:
        // the authenticated app already owns and displays this request.
        return reply({ status: 'approval_pending', requestId: result.id,
          expiresAtMs: result.expiresAtMs,
          nextAction: 'Approve the request in Sidewisp. No additional agent message is needed.' });
      } catch (error) {
        const allowed = /^(installation_already_connected|another_authorization_pending|device_authorization_http_[0-9]{3})$/;
        return reply({ status: 'blocked', reason: allowed.test(error.message) ? error.message : 'connection_preparation_failed' }, true);
      } finally { busy = false; }
    },
  };
}

export function registerConnectTool(api, options) {
  const tool = createConnectTool(options);
  // Host-derived admission only; prompt text cannot declare ownership.
  api.registerTool(context => context.senderIsOwner === true ? tool : null,
    { name: 'sidewisp_connect' });
}
