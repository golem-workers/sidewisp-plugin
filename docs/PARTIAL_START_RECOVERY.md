# Partial startup and initial heartbeat recovery

Confirmed on the unchanged .33 and .38 service body: throwing at collector.start or initial emitHeartbeat left side deliveries alive without the heartbeat timer. This reproduces a generic defect, not the historical Landing exception.

Repair:
- Every partial startup exception cleans owned side deliveries, timers, collector and spool handles before surfacing the failure; no credential deletion.
- After collector.start succeeds, heartbeat/auth synchronization runs under a single-flight supervisor. A transient initial heartbeat failure retries autonomously after 5 seconds, at most three consecutive attempts. Normal cadence is 30 seconds after completion.
- Explicit permission/auth rejection and spool failures enter blocked state with no retry. Existing signed-request authorization is unchanged.
- Initial checking/recovering/blocked/failed/timed-out states are not ready. A previously successful periodic check retains readiness until failure or its 15-second deadline; unpaired healthy service can be ready without inventing connection proof.
- Stop cancels the scheduled retry, aborts the signal and fences late completion by generation. emitHeartbeat checks cancellation before work and after authorization/snapshot awaits. Stop waits at most one second for a flight; late completion cannot schedule another tick or enqueue a heartbeat after those guarded awaits.
- An uncooperative hung operation remains single-flight, timed-out/not-ready, without launching overlapping replacement operations. It is NOT claimed to be forcibly terminated or autonomously repaired. Retry proceeds only after settlement. Initial collector.start exceptions still fail with cleanup; this unit specifically repairs transient initial heartbeat failures.

Tests cover actual registered service-body injection, autonomous recovery, auth rejection, bounded failure count, stop/retry races, hanging operation single-flight and readiness. Hosted staging acceptance uses an isolated real Gateway with a test-only initial emitHeartbeat exception; the package is a candidate based on .38, NOT an official .38 release or published update. Release archive/install/migration gates remain required before distribution. User Landing and Android UI acceptance remain separate.
