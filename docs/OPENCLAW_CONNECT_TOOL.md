# Native OpenClaw connection tool

Implementation status: source-only, not part of published 0.2.31. Requires release,
installation/activation and host tool admission. No platform image has been changed.

`sidewisp_connect({requestId, endpoint})` accepts a public invitation from the
initiating Sidewisp account. OpenClaw must identify the caller as the owner;
model-supplied ownership is not accepted. Endpoint must exactly match the configured
Sidewisp origin. The tool never changes endpoints, installs code, restarts the
Gateway or modifies other plugins.

A started healthy collector is required before creating the request. The existing
device-authorization implementation retains its proof locally (0600), checks the
old binding at the server, and preserves healthy credentials. The result contains
only the public request identifier, expiry and in-app approval instructions, not
verification codes, links, device proof or credentials. A pending result is NOT
connection success.

The user approves in the authenticated Sidewisp application. The existing collector
polls without another model turn, adopts the keys and uploads signed telemetry.
Deleting a binding revokes it at the backend, not the locally installed plugin.
A new public invitation and explicit approval can replace revoked credentials;
a healthy binding, unavailable server or conflicting pending request is preserved.

## First installation and distribution

For managed OpenClaw hosts, ship a validated plugin release in the host image and
allow its owner-scoped tool. For ordinary OpenClaw, perform the supported plugin
installation once. Neither distribution is accomplished by changing the APK.
Host runtime attestation and tool admission remain mandatory; this tool does not
repair or bypass a refused installation. Older installations need one supported
upgrade before the tool exists. Full monitoring hooks remain in the plugin.

## Evidence

`test/connect-tool.test.js`: admission, collector readiness, endpoint/input
injection, concurrent request exclusion, public-only responses, error sanitization.
`test/single-invitation.test.js`: OpenClaw now enters through the tool, then real
credential storage, collector synchronization and signed telemetry ACK; backend
and spool are simulated. Hermes helper path remains covered.
`test/device-authorization.test.js`: revoked-binding replacement, healthy binding
protection, outage preservation and explicit approval.

Not yet proven: installed release on a real Gateway exposing this tool, actual
model invocation under host admission, hosted-backend tool-driven reconnect,
platform preinstallation, installed Android acceptance. Prior CLI-driven live
proof does not establish these new tool acceptance cases.
