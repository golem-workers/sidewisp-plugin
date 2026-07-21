# Roadmap

This repository owns all Sidewisp runtime integrations. It will not be split into one repository per agent type.

## Invariants

- Zero LLM, embedding, and inference calls.
- Observe only; never control or invoke the monitored agent.
- Remediation is a deterministic prompt shown to the user for manual delivery.
- Outbound HTTPS only, with no inbound port on the agent.
- Runtime-neutral telemetry contract shared with future agent adapters.

## Production milestones

1. Shared adapter interface and `sidewisp.telemetry.v1` contract.
2. Typed OpenClaw lifecycle hooks and structured event normalization.
3. Hermes observability adapter using the same contract.
4. Durable local SQLite spool, batching, retry, and idempotency.
5. One-time setup-token exchange and signed ingestion.
6. Log/state recovery for events missed during adapter downtime.
7. Redaction and payload allowlisting.
8. Versioned deterministic incident rules.
9. Template-based remediation prompts for user review and manual delivery.
10. Package, git-install, upgrade, rollback, and compatibility tests.
11. Signed version tags followed by ClawHub distribution.
