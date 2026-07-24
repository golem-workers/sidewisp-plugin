# Installation and permission model

Sidewisp defaults to the least-privileged per-user installation mode. Installing the collector must never silently request administrator access or broad filesystem permissions.

## Common permissions

- Read only the explicitly detected runtime state/configuration paths owned by the current user.
- Write credentials and the SQLite spool only inside a Sidewisp-owned user state directory with owner-only permissions.
- Make outbound HTTPS requests to the configured Sidewisp endpoint.
- Never request screen recording, accessibility, microphone, camera, contacts, browser data, Full Disk Access, kernel extensions, or inbound network access.

## macOS

Default mode installs a signed and notarized collector in the user's application-support directory and a `LaunchAgent` under `~/Library/LaunchAgents`. This requires no administrator password and runs while that user is logged in. Gatekeeper verification must complete before enrollment.

Optional machine mode uses a `LaunchDaemon` under `/Library/LaunchDaemons` for hosts that must report before login. This mode requires an explicit administrator authorization prompt and must be presented separately; it is never the default.

## Linux

Default mode installs a systemd user service and user-owned state without `sudo`. Hosts that must run without a logged-in user may require administrator-approved lingering or a system service. The installer must explain that distinction before requesting elevation.

## Windows

Default mode runs in the current user's startup context without elevation. An always-on Windows Service is optional and requires an explicit administrator prompt.

## Runtime-native mode

When a runtime provides a reliable native background-plugin lifecycle, prefer it over a separate OS service. OpenClaw uses this mode. Hermes uses the per-user sidecar until an equivalent stable native lifecycle is available.

Codex and Claude Code use documented per-user command hooks. Installation
modifies only `~/.codex/hooks.json` or `~/.claude/settings.json`, preserves
existing handlers, and creates a one-time backup of an existing file. Each hook
stages one metadata-only event and starts a short-lived delivery worker. No
always-on service, administrator privilege, transcript access, or project-file
permission is required.

## Enrollment

The short-lived setup token is exchanged once. It is never written to the persistent service definition. The resulting installation credential is scoped to telemetry ingestion, stored owner-only, and can be revoked from Sidewisp.
