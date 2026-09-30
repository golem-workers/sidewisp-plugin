# Non-disruptive OpenClaw updates (0.2.35)

The old fleet controller must remain disabled. This release does not restart APIs
or the Gateway. `plugins install` and `plugins reload` are the only mutation
interfaces used for plugin replacement; host capability/approval decisions remain
in force.

OpenClaw 2026.9.6 retains plugin generations for the entire agent run. Therefore an
installation invoked from the setup conversation can persist files but reject
replacement with `active retained work`. Waiting only for OTHER conversations is
insufficient. `scripts/prepare-openclaw.mjs --enqueue` runs in a separate user
systemd unit and the setup turn must finish. It waits for idle, verifies the exact
archive SHA-256, applies the plugin, verifies the serving collector, then begins
the public invitation. The existing collector handles the owner's approval.
`--update-only` performs the same preparation for an existing installation without
creating an invitation, changing credentials or re-enrolling.
Only this exact transient host result is deferred. Policy denials are not retried.

The updater verifies archives locally. Busy replacement reloads the already
persisted installation instead of reinstalling it or restarting the Gateway.
An applied unhealthy target is restored through the supported plugin CLI from a
private backup; it is never overwritten while running. Backups persist across
idle deferrals. Unknown health and crashes fail closed; interrupted mutation or a
stale lock requires inspection, not blind retries. Readiness includes serving
version, enabled/running collector and unchanged endpoint/installation ID.

0.2.35 OpenClaw collectors check official GitHub releases every 15 minutes with
no model calls. A release must carry `fleet-rollout.json` with the existing
verified-fleet schema, `deliveryMode: host-idle-hot-reload-v1`, the environment,
an exact source-plugin/runtime-version cohort and real migration evidence with
`gatewayRestarts: 0`. The normal release pipeline must test and publish this
manifest; arbitrary releases and legacy restart-based manifests are ignored.
Private/custom endpoints are not automatically enrolled in this release channel.

Bootstrap is distinct from future updates. A 0.2.34 or older running updater
cannot be fixed by code it has not loaded yet. Existing hosts must receive the
verified 0.2.35 preparation helper once through their authorized host access.
Do not claim universal automatic delivery until that migration is verified.
Hermes update behavior is unchanged and is not covered by OpenClaw hot-reload
proofs. All state and credentials remain in their existing host directory.

Validation includes the full plugin suite, hash refusal/no-mutation tests,
retained-work and policy-denial tests, immutable release-discovery gates, and
isolated live Gateway migration/rollback with unchanged PID. See the release
verification report for exact delivered artifact and live connection evidence.
