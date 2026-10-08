// A missing delivery observer must not leave completed work running forever.
// Read only host-owned execution metadata; absence, timeouts and waiting are not terminal evidence.
export function createOpenClawWorkReconciliation({ request, activeWork, emit, revision = () => 0, now = Date.now } = {}) {
  let inFlight = null;
  let lastResult = { status: "not-started", reconciled: 0, at: null };
  const sameWork = (a, b) => a.kind === b.kind && a.sessionId === b.sessionId
    && a.turnId === b.turnId && a.messageId === b.messageId;
  const reconcile = async () => {
    if (typeof request !== "function") return { status: "unavailable", reconciled: 0 };
    const observedAt = now();
    const observedRevision = revision();
    const observed = activeWork();
    if (!observed.length) return { status: "idle", reconciled: 0 };
    const sessions = new Map();
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const result = await request("sessions.list", {
        limit: 100, offset, includeGlobal: true, includeUnknown: true,
      }, { timeoutMs: 5_000 });
      if (!Number.isFinite(result?.ts) || result.ts < observedAt
          || !Array.isArray(result.sessions)) return { status: "unavailable", reconciled: 0 };
      for (const session of result.sessions) sessions.set(session.key, { ...session, snapshotAt: session.snapshotAt ?? result.ts });
      if (!result.hasMore) break;
      if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset) return { status: "unavailable", reconciled: 0 };
      offset = result.nextOffset;
    }
    if (revision() !== observedRevision) return { status: "raced", reconciled: 0 };
    let reconciled = 0;
    for (const work of observed) {
      const session = sessions.get(work.sessionId);
      if (!session || session.snapshotAt < observedAt || session.hasActiveRun !== false
          || !Array.isArray(session.activeRunIds) || session.activeRunIds.length !== 0
          || !Number.isFinite(session.endedAt)
          || !["done", "error", "aborted"].includes(session.status)) continue;
      const runIds = work.kind === "task"
        ? [work.outerRunId, ...(work.internalRunIds ?? [])].filter(Boolean) : [work.turnId];
      const exact = runIds.includes(session.lastRunId);
      // Another run's success cannot prove this work succeeded. Close obsolete
      // restored work as interrupted, never as a fabricated successful result.
      const outcome = !exact || session.status === "aborted" ? "cancelled"
        : session.status === "error" ? "failure" : "success";
      // A request can race a new admitted turn in the same session. Revalidate
      // the complete stable work identity and bound runs before changing it.
      const current = activeWork().find(candidate => sameWork(candidate, work));
      if (!current || JSON.stringify(current) !== JSON.stringify(work)) continue;
      if (await emit({ kind: "turn_end", outcome, component: "runtime_reconciliation",
        correlation: { sessionId: work.sessionId, turnId: work.kind === "task"
          ? work.outerRunId ?? work.internalRunIds?.at(-1) ?? work.turnId : work.turnId },
      }, work)) reconciled += 1;
    }
    return { status: "checked", reconciled };
  };
  return Object.freeze({
    status: () => ({ ...lastResult }),
    reconcile() {
      if (inFlight) return inFlight;
      inFlight = reconcile().catch(() => ({ status: "unavailable", reconciled: 0 })).then(result => {
        lastResult = { ...result, at: new Date(now()).toISOString() };
        return result;
      }).finally(() => { inFlight = null; });
      return inFlight;
    },
  });
}
