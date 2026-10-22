# Native OpenClaw connection tool

Introduced in 0.2.32. Requires installation/activation and host tool admission.
No platform image is changed by publishing this package.

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

Version 0.2.33 fixes cold/standalone tool instances: service readiness belongs to
the serving Gateway, not the tool-discovery instance. A cold instance reads
`sidewisp.status` via authenticated OpenClaw transport, checks actual readiness,
the configured endpoint, and a SHA-256 identity of the real local state directory.
Disabled/unavailable/mismatched collectors fail closed. No duplicate collector,
runtime repair, restart, or installation is performed by the tool.

The isolated 0.2.32 reproduction has a running Gateway collector and nevertheless
returns collector_not_ready from the real standalone OpenClaw tool loader.
See the release verification report for the corrected archived-plugin live cycle.
This is not proof of installation on every host, model interpretation of the
prompt, or acceptance from installed Android.
