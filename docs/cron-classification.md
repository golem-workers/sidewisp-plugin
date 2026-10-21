# Native cron monitoring classification (unreleased candidate)

Only monitoring metadata changes. The reader stays query-only, inventories every
saved row (including disabled and at/every/cron), validates the entire inventory,
and sends every normalized ID. No scheduler, enabled flag, schedule, payload,
execution, delivery, installation or enrollment code is changed.

## Evidence and rule 1

The native contract is pinned to OpenClaw 2026.9.8, inspected build
fc23bc864e4553c2d215e479eeec47b67a0bf943 and bundled memory-core 2026.9.8.
`api.runtime.version` supplies the version to collection and watching. Only the
exact version string `2026.9.8` enables classification; absent, older, newer or
custom version strings retain all rows as unknown. Adding a version requires
inspection of its native creators and namespace guard, not semver inference.
The runtime version is not cryptographic proof of an unmodified native binary.

Classify before metadata normalization loses declaration/payload evidence:

- `memory-core:memory-dreaming-promotion`: exact declaration and canonical token
  digest, agentTurn, lightContext=true, isolated, cron schedule, wakeMode=now,
  delivery.mode=none. Token comparison is local; no token or payload is sent.
- `heartbeat:<agentId>`: canonical nonempty suffix and payload.kind=heartbeat.
- `skill-collection-review:<agentId>`: canonical nonempty suffix in the pinned
  version with its inspected reserved creation namespace.

If present agentId/owner.agentId disagrees with a monitor suffix, or createdActor
is present and not system, retain unknown. A missing creator is not proof of a
human or system creator. Names and enabled states do not classify a row.

Never blanket-exclude heartbeat-task (including Doctor-imported user tasks),
native jobs, systemEvent, actor=system, isolated sessions or delivery.mode=none.
Unrecognized and conflicting provenance is retained, not asserted user-authored.

## Additive collector DTO

`sidewisp.cron-snapshot.v1` and its existing fields remain. Each normalized job
adds only `classification: { kind, ruleVersion: 1 }`, where kind is one of
`unknown`, `memory-dreaming`, `heartbeat-monitor`, `skill-collection-review`.
No declaration, native marker, owner, creator, prompt, command, delivery target
or credential is added to the wire. The backend accepts legacy jobs without this
field. The old backend uses closed validation and rejects new jobs: deploy the
compatible backend first. No automatic protocol downgrade or installer is added.

All IDs still reach the backend for durable discovery dedupe, including hidden
builtins. The backend alone applies the same visibility policy to list and new
notification creation. Existing mobile DTO, active-list semantics and its
items.length counter remain unchanged; disabled/completed-at rows remain in the
inventory but not in that existing active screen. There is no APK/OTA change.

Old collectors/snapshots without classification cannot hide builtin jobs;
unknown runtime versions cannot either. Do not infer classification from a name,
backfill old snapshots or replay pending notifications. A downgraded collector
can make builtin rows visible again; seen IDs still suppress duplicate discovery.

## Separate known issue: on-exit/stream coverage

This patch does not add support for native on-exit or stream schedules. Any such
row (including a builtin) still produces unavailable for the **whole** snapshot.
Classification never removes an invalid/unsupported row to make a partial list
look complete. The server preserves previous inventory with a non-ok status,
not a new empty/full successful inventory. Supporting these schedule kinds is a
separate DTO/reader change. Other stores/Gateways, OS/external schedulers and
Hermes/Codex/Claude Code native inventories remain outside this OpenClaw reader.

## Verification

`node --test test/cron-classification.test.js test/cron-monitor.test.js test/cron-sqlite.test.js`
uses artificial task data and temporary JSON/SQLite only. No cron is executed.
Full suite: `npm test`. Staging acceptance must be separately authorized; source
and in-process tests are not proof of deployed collector or phone delivery.
