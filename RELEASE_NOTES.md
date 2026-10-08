# Sidewisp Plugin v0.2.47 (tester prerelease)

- Reconcile user work against fresh, explicit host-owned terminal session metadata when the Gateway drops the final-dispatch observer.
- Completed, failed and interrupted work retain distinct outcomes; a different run's success never credits obsolete restored work as successful.
- Preserve live/waiting work, stable work IDs, race fencing, terminal enqueue rollback and Telegram previews. Unavailable, partial or stale metadata never clears work.
- No mobile runtime change, connection replacement, Gateway restart or production fleet rollout is required.
