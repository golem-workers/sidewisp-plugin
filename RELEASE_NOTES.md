## 0.2.56 — native SQLite cron inventory

- Read the authoritative OpenClaw shared SQLite cron partition read-only, including WAL and runtime state.
- Preserve legacy JSON support only when SQLite is absent; corrupted or incomplete inventories fail closed.
- Observe SQLite changes without uploading unrelated shared-state changes.
- Preserve credentials, binding, scheduler and agent configuration.

# Sidewisp Plugin v0.2.54

Empty release for measuring event-driven automatic update latency.
Runtime code and behavior are unchanged from immutable v0.2.53.
Independent update manager remains pinned to v0.2.53; no re-bootstrap is required.
