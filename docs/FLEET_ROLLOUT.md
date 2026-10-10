# Automatic discovery disabled

The plugin no longer starts a periodic release-discovery timer. Publishing a release alone does not cause this build to install it. Explicit authorized delivery remains supported. The older controller deployment described below must remain disabled; it is not the active rollout policy. Telemetry and diagnostic intervals are unchanged.

# Verified fleet rollout

`src/release/fleet-rollout.js` implements a deterministic, read-only release
decision engine. `node scripts/plan-fleet-rollout.mjs input.json` prints a plan.
The deployment also includes a release publisher/discovery service and a
persistent runtime controller. Deployment status must still be verified on the
actual host; code and passing tests alone are not evidence of an enabled timer.

## Inputs and guarantees

- A release specifies version, full commit, artifact SHA-256, explicitly enabled
  environments, and `verifiedMigrations`: exact `runtime/pluginVersion/runtimeVersion`
  tuples that passed real source-updater migration tests. A manifest is a record
  of completed verification, not a substitute for performing it.
- Each installation carries id, runtime, runtimeVersion, version, status,
  credentialActive, lastSeen (epoch milliseconds), and optional update status,
  observedAt, and attemptAt. Use server-verified credentials and durable telemetry.
- Retain separate persistent state for each release and environment. Never reset
  halted state to retry an update. Changing a release requires fresh evidence and
  state; failed installations require a separately verified recovery.
- Select one live canary per verified migration tuple. Expand only after a
  correlated terminal success, target version, fresh heartbeat, and a two-minute
  minimum observation window. Server evidence is not a host/Telegram check.
- Never infer completion from target version alone. Withdraw directives on
  failure, rollback, skipped attempt, timeout, revocation, disappearance of an
  unfinished installation, or a completed version regressing.
- Keep the global rollout percentage at zero. Unsupported and offline records
  stay visible with explicit reasons. A returning installation is considered on
  the next tick, provided its exact source migration is verified.

## Publication and runtime

After a release archive is published and its exact source transitions have passed,
prepare `fleet-rollout.json` with schema `sidewisp.verified-fleet.v1`, version,
commit, sha256, environments, verifiedMigrations and migrationEvidence. Each
proof contains cohort, targetVersion, artifactSha256, status=completed,
sourceUpdaterTested=true and isolated=true. These fields attest actual tests;
never fabricate evidence to qualify an old updater.

Run `npm run release:fleet -- /absolute/path/fleet-rollout.json`. The publisher
resolves the official Git tag, downloads and hashes the archive, checks its package
version and migration attestations, and attaches the immutable manifest to the
existing GitHub release. A conflicting existing manifest is rejected.

The discovery timer checks official GitHub releases every 15 minutes and repeats
artifact verification before accepting a manifest for each explicitly authorized
environment. Ordinary releases without the verified manifest do not trigger a
rollout. The controller timer runs every minute, reads installations and terminal
snapshots from PostgreSQL, plans a canary/expansion, persists state, and updates
only the six plugin policy environment settings. It restarts APIs only if those
settings actually change. Failed readiness restores all modified instance files
and restarts them on the previous settings; a durable APPLY_BLOCKED marker stops
further changes until reviewed. Unrelated settings and credentials are preserved.

Config `/etc/sidewisp-fleet/<environment>.json` defines envFiles, pgModule,
releaseFile, stateDir, targets (envFile/unit/readyUrl), quarantined IDs, and apply.
No credentials are stored in manifests or status reports. The controller loads
the existing protected runtime environment. State is private and separate per
environment/release. New releases cannot silently abandon unresolved prior ones.
Inspect status.json and systemd service failures; there is no model polling.

Production with no diagnostic table is monitored but cannot start a canary whose
terminal result cannot be verified. Unsupported source migrations, quarantined
installations, and offline records remain visible; enabling the services does not
mean those installations have been updated. The existing older agent helper uses
git spec, not the manifest archive hash, during live installation. Publisher hash
validation is not a claim of per-host archive checksum verification.

Validation: `npm run test:fleet`, full `npm test`, real host read-only controller
plan, actual manifest discovery, systemd timer/service status, policy readback,
API readiness, and unchanged backend revisions. Keep the old service configuration
and policy backups for rollback.

## September 29 investigation

Staging has five OpenClaw installations plus an offline Hermes installation.
Production has sixteen OpenClaw records plus one Hermes record, all without
fresh telemetry at inventory time. These are installation records, not proof of
twenty-three unique live hosts.

One staging source 0.2.33 updater reported `failed`; its server rollout allowlist
entry was removed. Host diagnostics require restoring the provisioned owner-peer
API (HTTP 401), whose supported setup tool is also unavailable. Do not bypass it.

Production source 0.2.17 and 0.1.18 schedulers spawn a detached child in the
Gateway's service cgroup, unlike the newer external `systemd-run` updater. Their
helpers also lack the current inspection path handling. A newer target release
cannot fix a helper that is interrupted before installing it. Legacy migrations
therefore need separately tested bootstrap/recovery, not global 100% rollout.
