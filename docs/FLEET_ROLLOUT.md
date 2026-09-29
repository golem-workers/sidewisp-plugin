# Verified fleet rollout (decision engine; not deployed)

`src/release/fleet-rollout.js` implements a deterministic, read-only release
decision engine. `node scripts/plan-fleet-rollout.mjs input.json` prints a plan.
This is **not yet a running release publisher or fleet controller**. It must not
be described as automatic updating enabled in production.

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

## Remaining integration gates

The deployment adapter must serialize ticks, atomically persist state before
applying an allowlist, publish only validated immutable releases, preserve
unrelated runtime settings, and rollback failed backend configuration switches.
The release publisher must verify downloaded artifact hash/tag and real migration
proofs before creating the manifest. These adapters are deliberately not enabled
while current live rollout recovery is blocked.

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
