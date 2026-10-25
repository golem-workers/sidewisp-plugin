# Sleep, reconnect and deferred updates

Platform wake and Sidewisp recovery are separate responsibilities. An ordinary
message must reach the existing durable platform wake queue; Sidewisp must not
wake a VM merely to check a release. No Sacra-specific routing is involved.

## Implemented in this candidate

- Shared telemetry requests, manager heartbeats and the managed update stream
  use wall-clock deadlines. A suspended process discards a stale socket after
  resume, then normal bounded transport recovery signs a fresh request. The
  stream reconnect receives the server's current policy snapshot.
- A valid managed directive is fsync-persisted before it is acted upon, in
  `sidewisp/pending-release.json`. Manager replacement and a lost stream do not
  erase an already accepted target while the profile worker is busy.
- Pending state is scoped to endpoint, installation, physical state directory
  and credential generation. Rotation/rebinding cannot replay it. An explicit
  policy withdrawal removes it; credential rejection removes the pending target.
- The existing independent OpenClaw worker remains the sole installation owner.
  It verifies the pinned archive, waits for host idle admission, and records the
  same durable attempt across deferrals. It never forces an active turn to stop.
  The release journal has priority over a newer pending target until terminal.
- Runtime configuration, credentials, bindings, spool and task history are not
  copied, reset, restored or removed by these changes. No enrollment is started.

A valid server-accepted pending directive is an authorized intent, not a GitHub
version-discovery cache. Offline recovery can continue it, just like an existing
worker journal. A release withdrawal not yet received cannot be known offline.
No failed or completed revision is reopened by pending-state restoration.

## Runtime boundary and remaining gates

The Golem platform currently declares OpenClaw and Hermes agent types.
The transport fix is shared by their uploaders (and the standalone Codex/Claude
Code adapters), but that is **not** proof of automatic installation on each.
The independent managed installer in this source is OpenClaw-specific. Hermes
still uses its separate collector helper and has no equivalent authoritative
host-idle admission contract in this source. Extending automatic installation to
Hermes requires that contract and a verified platform bootstrap/manager path;
this candidate does not claim to have supplied it.

A short, automatic runtime reconnect can still occur when the installed SDK
requires activation. Preserving active work and requiring no manual reconnection
are the contract; uninterrupted network transport across VM sleep is not possible.

## Verification

Tests cover accepted-target recovery after manager replacement, withdrawal,
credential rotation and profile isolation; refusal to install during active work;
one installation after work completes; unchanged settings/binding/spool bytes;
fresh signed stream reconnect after simulated wall-clock sleep; and preserving
unacknowledged events after an interrupted response body. A subprocess test uses
real SIGSTOP/SIGCONT and checks that an old request deadline expires on resume.
These are local process/contract checks, **not** a provider VM hibernate/restore.

Before fleet rollout, record exact release hash and, for each supported provider
and runtime: message while hibernated -> one durable wake -> original message
runs once -> Sidewisp accepts a fresh heartbeat -> new verified release waits
while work is active -> update completes after idle -> settings/data/binding and
native message response remain intact. Also test no release, policy withdrawal,
credential rejection, active-work races and another sleep during the update.
Use a designated test agent; discovery visibility alone is not lifecycle access.
