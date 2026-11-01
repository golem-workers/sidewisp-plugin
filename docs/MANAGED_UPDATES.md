# Managed automatic updates

OpenClaw Linux/systemd hosts install the independent per-user service using
`scripts/install-update-manager.mjs ENDPOINT` from a verified release. Explicit
active OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH are required. The installer
copies its code outside the plugin to STATE/sidewisp/manager and preserves the
existing enrollment. `prepare-openclaw.mjs` installs it too. Supported existing
connections can receive one idempotent native migration task; that initial
bootstrap uses a model, subsequent updates do not.

The service sends a signed control heartbeat every 60 seconds and on startup.
It never discovers releases on GitHub. The server returns a required immutable
version, SHA-256 and revision. Operator trigger: backend
`scripts/require-plugin.mjs DIRECTORY VERSION SHA256 --all`, or installation IDs
for a canary. Atomic policy changes require no API restart. A valid policy with
an empty installation list withdraws updates. The copied manager survives plugin
replacement and continues checking even if collector code fails.

Only official Sidewisp artifacts are fetched. Host install/reload interfaces gate
replacement: active work defers it; Gateway is never restarted. Completion checks
serving version, readiness and unchanged endpoint/installation. Rollback material
persists until success. Failed/rolled-back attempts block their policy revision;
a new operator revision permits retry after repair. Interrupted mutation or a
stale lock needs inspection, not blind retry. Host approvals are not bypassed.

Installation API `managedUpdate` reports bootstrap_required, offline, pending,
failed, current or unmanaged plus the target, serving version and report time.
Manager heartbeats do not fabricate collector liveness. Supported live migration:
OpenClaw 2026.9.6 on Linux/systemd. Collectors below 0.2.34 lack the native task
channel and need one authorized host bootstrap. Hermes, Codex, Claude Code and
non-systemd hosts are not represented as supported. The old server fleet timers
remain disabled; the removed 15-minute GitHub timer is not restored.

## Host-idle authority (0.2.42 tester)

The external helper obtains `diagnostics.lanes` from the serving OpenClaw Gateway. All host lane and dynamic active/queued counts must be valid zeroes; missing/refused diagnostics fails closed. Collector user-task cursors can retain historical interrupted synthetic requester wakes and are telemetry, not installation authority. The installer and reload still enforce actual retained plugin-generation work; the current setup turn is never subtracted, and no task is stopped or Gateway restarted.

## Continuous recovery (0.2.87)

A fresh, supported signed manager is sufficient to receive a migration-proven
update even when the collector has stopped reporting. This does not attest
collector health: completion still requires fresh target collector telemetry,
correlated manager completion, stability and the expected native reply.

After a successful connection, the manager maintains the already installed
plugin independently of update directives. After two minutes of failed local
readiness it queues one profile-scoped recovery worker outside the Gateway and
manager cgroups. The worker verifies the saved binding and installed version,
requires real host idleness, and first restarts a failed collector in its original
service context through a binding-checked local operator RPC. When that path is
unavailable it uses the supported plugin reload. An explicit
cold-activation requirement uses the existing suspension-fenced activation.
It never reinstalls a different package, edits settings, overrides a disabled
plugin, discards data, reopens a completed journal, or bypasses retained work.
Failures back off to at most one attempt per fifteen minutes. Failed/interrupted
update transactions remain separate and are not silently retried.

A delivered 0.2.87 package can upgrade an older canonical independent manager
without a model task. A separate systemd worker waits for any update helper to
release its kernel lock, then invokes the existing manager installer. It
preserves unit customizations, manager configuration and credentials; an
unrecognized owner entrypoint or restart policy still requires diagnosis.
Fresh setup continues to install the manager before completing connection.

Both silent channels still require an independent host access path; manager-only
delivery is not claimed to explain or repair a completely unreachable host.
