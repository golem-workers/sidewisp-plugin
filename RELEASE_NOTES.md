## 0.2.58 — ordinary reply previews

- Preserve ordinary words, cron names, paths and links in message previews while omitting credential values, known token formats and opaque keys.
- Keep plugin and API preview policy aligned. Automatic final observation also requires the separately published OpenClaw 2026.9.8 reply-observer hotfix.
- No work status, binding, cron, or notification changes.

## 0.2.57 — optional safe message preview

Agent activity can include a single-line messagePreview of at most 160 characters. Missing or sensitive messages omit the field. Work statuses, notifications, native cron and connection semantics are unchanged. Requires the compatible API release before activation.

## 0.2.56 — native SQLite cron inventory

- Read the authoritative OpenClaw shared SQLite cron partition read-only, including WAL and runtime state.
- Preserve legacy JSON support only when SQLite is absent; corrupted or incomplete inventories fail closed.
- Observe SQLite changes without uploading unrelated shared-state changes.
- Preserve credentials, binding, scheduler and agent configuration.

# Sidewisp Plugin v0.2.54

Empty release for measuring event-driven automatic update latency.
Runtime code and behavior are unchanged from immutable v0.2.53.
Independent update manager remains pinned to v0.2.53; no re-bootstrap is required.
