# Partial service-start failure

The unchanged 0.2.33 registerService body was evaluated with injected dependencies and deterministic timers. Injection at collector.start and initial emitHeartbeat reproduced live diagnostics/context/usage plus upload timer after start rejected, with no heartbeat timer. This is a service-body fault-injection regression, not proof that Landing encountered the exception.

The same ordering remains in 0.2.38. Diff from v0.2.33 adds scheduleRunner and version, not a cron dependency for the heartbeat.

The first repair cleans every partially started delivery, timer and spool before rethrowing non-Spool errors. It also stops scheduleRunner and collector. Security/auth errors remain errors; no heartbeat is invented. Both regression cases pass and the plugin suite passes 259 tests.

This checkpoint is not a complete recovery implementation: automatic retries, bounded hung operations, serialized heartbeat execution and truthful recovering readiness still require implementation and tests. No release/deployment performed. Actual .33 happy-path service timer and delete/reapprove against staging separately passed three real heartbeat receipts per binding with cron disabled.
