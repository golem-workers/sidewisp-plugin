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
An actually applied unhealthy generation is rolled back. Interrupted mutations
and unknown host state remain fail-closed. Model execution is not used for
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

Use archive 0.2.51 or later: 0.2.50 is superseded before rollout because its
credential watcher could generate metadata events recursively.
