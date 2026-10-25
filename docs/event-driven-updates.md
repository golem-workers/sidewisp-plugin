# Event-driven managed updates (OpenClaw)

The Linux/user-systemd update manager uses its own signed HTTPS event connection,
independent of the Gateway and replaceable plugin. It runs from a private copy in
`STATE_DIR/sidewisp/manager/releases/VERSION`. Supported source runtimes remain
OpenClaw 2026.9.6 / 2026.9.8; other runtimes are not claimed as verified.

The verified backend release publisher emits a durable publication event. The
controlled rollout writes an immutable archive hash, target and revision to
`required.json`; its atomic replacement immediately notifies subscribed managers.
Startup/reconnection receives the current policy, so an offline agent cannot lose
a release. No periodic GitHub/version check is performed. The existing minute
manager heartbeat reports health and attempt results only; its update response
is intentionally ignored. SSE keepalives, network recovery backoff and bounded
host-idle waits are transport/installation mechanisms, not version-discovery timers.

Every reconnect uses fresh HMAC timestamp/nonce, with no credential in a URL.
Identity, directive and hash are validated before installation. A credential
rotation/rebinding aborts the old stream; revoked/expired credentials close the
server stream. Invalid policy withdraws directives. Duplicate events cannot
launch concurrent helpers or retry a terminal failed/rolled-back revision.

The existing helper downloads the official hash-pinned artifact, waits for real
host idleness, installs/reloads safely, preserves binding and verifies readiness.
An unhealthy current release has a bounded forward repair budget, never a downgrade.
Each helper runs in a separate profile-scoped systemd service. Stops of the manager
or Gateway do not kill it. Worker/host interruption resumes the same durable journal
when the manager returns, without a new release event. Accepted pre-install intents
are resumable too. Unknown binding/profile, legacy locks, policy refusals and terminal
failures remain fail-closed. Model execution is not used for
ongoing updates. Publication cannot clear an operator pause or an unresolved
failed release.

## One-time preparation

Deploy the compatible backend stream before upgrading private managers. Extract
the exact official SHA-256-verified archive into a persistent private directory;
set the explicit active `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH` and any profile,
port and systemd-unit settings, then run:

```
node scripts/install-update-manager.mjs EXISTING_SIDEWISP_ENDPOINT --upgrade
```

This updates only the independent service; it does not update the plugin, restart
Gateway or re-enroll. The standard fresh preparation helper calls this installer;
existing supported installations can receive the same one-time native bootstrap
task. A healthy older connection alone is not proof that the new manager is
installed. Hosts without user-systemd or a supported native bootstrap need their
own verified preparation path. Preserve custom unit/config settings and do not
remove a helper lock to force manager upgrades.

Use archive 0.2.83 or later for interruption-safe workers. This is a one-time
private-manager migration, not a model task required for each future plugin update.
Use archive 0.2.51 or later for the original event-stream behavior: 0.2.50 is superseded before rollout because its
credential watcher could generate metadata events recursively.

## Automatic restart (0.2.84)

The profile manager uses `Restart=always`: its handled SIGTERM exits successfully,
but an unsolicited termination must still restart it. `systemctl --user stop`
remains an explicit stop and is not automatically undone. Explicit manager upgrade
migrates only the recognized old `Restart=on-failure` setting, preserves owner
additions, refuses a deliberate alternative restart policy and restores the old
unit policy together with code if activation fails. The Gateway remains under its
own existing host service; enrollment does not override that service's owner policy.

Boot autostart additionally requires an enabled user service and user-manager
lingering. An enabled unit alone does not prove that it starts without a login.
Validate server-accepted collector and manager heartbeats after a changed VM boot
ID before opening an SSH/login session; never extrapolate a process restart test
to a full-machine reboot or to a suspended/depowered VM.

Version 0.2.85 additionally verifies `loginctl show-user CURRENT_ACCOUNT --property=Linger --value` before handing preparation to user-systemd and before enabling the independent manager. When disabled, it enables linger for that same account and verifies it again. Unavailable logind or denied permission blocks successful setup with `user_boot_autostart_unavailable`; it never runs sudo or substitutes another account. This closes the clean-host case where a queued helper and enabled Gateway die on the last logout, before connection can finish.
