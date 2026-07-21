# Roadmap

## Invariants

- Zero LLM, embedding, and inference calls.
- Observe only; never control or invoke the monitored agent.
- Remediation is a deterministic prompt shown to the user for manual delivery.
- Outbound HTTPS only, with no inbound port on the agent.
- Runtime-neutral telemetry contract shared with future agent adapters.

## Production milestones

1. Typed OpenClaw lifecycle hooks and structured event normalization.
2. Durable local SQLite spool, batching, retry, and idempotency.
3. One-time setup-token exchange and signed ingestion.
4. Log/state recovery for events missed during plugin downtime.
5. Redaction and payload allowlisting.
6. Versioned deterministic incident rules.
7. Template-based remediation prompts for user review and manual delivery.
8. Package, git-install, upgrade, rollback, and compatibility tests.
9. Signed version tags followed by ClawHub distribution.
