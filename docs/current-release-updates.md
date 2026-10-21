# Single-current plugin updates

Sidewisp has one desired immutable plugin release. Updates are delivered by the existing signed installation event stream; reconnect supplies the current snapshot. Transport health checks and bounded idle retries are not release/version polling.

The independent profile-scoped systemd manager owns installation, outside the Gateway and replaceable plugin. Upgrade the manager once to 0.2.52 before assigning this strategy. The legacy collector scheduler stays suppressed whenever a manager config exists. Existing installations below the supported source/runtime cohort require separately verified preparation; an event alone cannot prepare them.

`openclaw-update-helper.mjs` verifies the official archive hash before mutation and records an fsync-backed `sidewisp/current-update.json` intent. A kernel lock serializes workers and is released after process death. A resumed worker continues the same desired release; it never installs an old plugin. There are at most two install attempts per revision. A failed code release waits for a corrected immutable release instead of reinstalling forever.

Installation uses the existing OpenClaw capability policy and host idle admission. Cold activation uses the exact managed profile and atomic suspend lease. Stopped-profile recovery validates the exact service/config/state before reinstallation and start. A running host with uncertain admission is never forcibly restarted. The durable authorized repair intent survives event-stream/control-plane disconnection; revoked credentials block new actions. A busy host reports deferral.

Credentials, installation identity, endpoint, owner settings, task history and spool are not restored from an old snapshot or deleted. No reenrollment is part of a healthy upgrade. Existing SDKs may require a short Gateway reconnect; active tasks must finish first.

Publish an immutable GitHub tag/archive after the full plugin checks. Verify that exact archive on the actual supported SDK (including interrupted installer, stopped Gateway, preserved binding, fresh accepted heartbeat and a real native task reply). Build `managed-rollout.json` from that evidence and publish it with the existing `sidewisp-publish-managed-release` command. Its verified publication event advances the deployed controller, not a GitHub polling timer. A manual GitHub UI upload alone is not this publication procedure.

The controller uses a full source/runtime/manager cohort, counts stability from first confirmed ready target, resets on loss of readiness, requires a second fresh observation and exact native acceptance reply, and admits bounded batches (default 2, max concurrency 2). Historical quarantined hosts are not silently retried. Offline hosts receive the current release when they return; unsupported/offline/recovery-required is never reported as completion.

The mobile app contract and notification/enrollment code are unchanged. Validate physical phone push separately when a registered test device is available; backend regressions do not establish a visible push on a phone.
