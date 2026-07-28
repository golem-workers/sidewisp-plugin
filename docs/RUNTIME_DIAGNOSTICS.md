# Runtime diagnostics delivery

Sidewisp collects a read-only, allowlisted `sidewisp.runtime-diagnostics.v1`
snapshot. It never invokes arbitrary shell commands and excludes logs, prompts,
messages, command output, environment values, paths, and credentials.

## Scheduling and recovery

- Default cadence: 15 minutes; configurable from 1 minute to 24 hours.
- Startup jitter: uniformly distributed across one cadence.
- Maximum unchanged refresh: 60 minutes by default.
- Collection is single-flight and independent of the telemetry uploader.
- The SQLite spool retains one replaceable snapshot per installation. New
  snapshots atomically coalesce older pending snapshots.
- Network failures use bounded exponential backoff. Shutdown waits for active
  collection and makes one final delivery attempt.
- Additive spool storage remains readable by older plugin releases.

## Resource budgets

The schema bounds each snapshot to seven sections, 64 facts per section, and
128 characters per scalar. With the current JSON encoding this keeps the
uncompressed request below 128 KiB. The spool is governed by the shared 64 MiB
disk cap, while diagnostics occupy at most one pending row per installation.

At the default cadence the network budget is at most 96 full snapshots per
installation per day; change detection normally reduces this to 24 unchanged
refreshes. Probe execution has a 2 second per-section timeout and delivery a
10 second request timeout. Tests assert single-flight behavior, latest-only
offline recovery, crash persistence, bounded jitter, retry backoff, and
privacy-safe deterministic output.
