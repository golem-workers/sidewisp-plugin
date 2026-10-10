import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawWorkReconciliation } from "../src/adapters/openclaw/work-reconciliation.js";
import { createOpenClawUserTaskLifecycle } from "../src/adapters/openclaw/hooks.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";
const sessionId = "agent:main:telegram:group:test";
const task = { kind: "task", sessionId, messageId: "message", turnId: "message", started: true, internalRunIds: ["run"] };
const done = { key: sessionId, snapshotAt: 101, hasActiveRun: false, activeRunIds: [], endedAt: 99, status: "done", lastRunId: "run" };
const envelope = { eventId: "sw_evt_reconcile_fixture", installationId: "sw_ins_fixture", sequence: 1, occurredAt: "2026-10-08T00:00:00.000Z", observedAt: "2026-10-08T00:00:00.000Z", runtime: { version: "2026.9.8" }, source: { kind: "hook", adapterVersion: "0.2.46" } };
const fact = (type, turnId, details = {}, messageId) => ({ ...envelope, type, correlation: { sessionId, turnId, ...(messageId ? { messageId } : {}) }, details });
const fixture = (session = done, work = [task], extra = {}) => {
 const inputs = [];
 const reconciler = createOpenClawWorkReconciliation({ now: () => 100, activeWork: () => work,
  request: async () => ({ ts: 101, sessions: session ? [session] : [] }), emit: async input => { inputs.push(input); return true; }, ...extra });
 return { inputs, reconciler };
};
test("missing final observer is repaired by exact host terminal metadata", async () => {
 const life = createOpenClawUserTaskLifecycle();
 life.process(fact("message.received", "outer", { component: "before_dispatch" }, "message"));
 life.process(fact("turn.started", "run"));
 const { reconciler } = fixture(done, [], { activeWork: () => life.activeWork(), emit: async input => {
  const event = normalizeRuntimeEvent("openclaw", input, envelope).event;
  const result = life.processDetailed(event); assert.equal(result.disposition, "accepted");
  life.commit(result.event); return true;
 } });
 assert.equal(life.status().activeRuns, 1);
 assert.equal((await reconciler.reconcile()).reconciled, 1);
 assert.equal(life.status().activeRuns, 0);
 assert.equal((await reconciler.reconcile()).reconciled, 0);
});
test("absence, unknown fields, live, waiting, stale and paginated omission never mean success", async () => {
 for (const session of [null, { ...done, hasActiveRun: true }, { ...done, activeRunIds: ["run"] },
  { ...done, activeRunIds: undefined }, { ...done, status: "waiting" }, { ...done, endedAt: undefined },
  { ...done, snapshotAt: 50 }]) {
  const { reconciler, inputs } = fixture(session); await reconciler.reconcile(); assert.deepEqual(inputs, []);
 }
 const { reconciler, inputs } = fixture(done, [task], { request: async () => { throw Error("transport"); } });
 assert.equal((await reconciler.reconcile()).status, "unavailable"); assert.deepEqual(inputs, []);
});
test("obsolete restored run is interrupted, not credited with a different run's success", async () => {
 const life = createOpenClawUserTaskLifecycle(); life.restoreActiveWork([{ kind: "run", sessionId, turnId: "old" }]);
 let emitted;
 const { reconciler } = fixture(done, [], { activeWork: () => life.activeWork(), emit: async input => {
  emitted = normalizeRuntimeEvent("openclaw", input, envelope).event;
  const result = life.processDetailed(emitted); life.commit(result.event); return true;
 } });
 await reconciler.reconcile(); assert.equal(emitted.type, "turn.cancelled"); assert.equal(life.status().activeRuns, 0);
});
test("host failed and aborted outcomes retain their correct terminal state", async () => {
 for (const [status, expected] of [["error", "failure"], ["aborted", "cancelled"]]) {
  const { reconciler, inputs } = fixture({ ...done, status }); await reconciler.reconcile();
  assert.equal(inputs[0].outcome, expected);
 }
});
test("activity arriving while snapshot request is pending fences reconciliation", async () => {
 let revision = 0;
 const { reconciler, inputs } = fixture(done, [task], { revision: () => revision, request: async () => {
  revision += 1; return { ts: 101, sessions: [done] };
 } });
 assert.equal((await reconciler.reconcile()).status, "raced"); assert.deepEqual(inputs, []);
});
test("all session pages are inspected and concurrent ticks stay single-flight", async () => {
 let count = 0;
 const { reconciler, inputs } = fixture(done, [task], { request: async (_, params) => {
  count += 1;
  return params.offset === 0 ? { ts: 101, sessions: [], hasMore: true, nextOffset: 100 }
   : { ts: 101, sessions: [done], hasMore: false };
 } });
 const a = reconciler.reconcile(), b = reconciler.reconcile(); assert.equal(a, b);
 await Promise.all([a, b]); assert.equal(count, 2); assert.equal(inputs.length, 1);
});
test("durable terminal enqueue failure keeps work active for a later retry", async () => {
 const life = createOpenClawUserTaskLifecycle(); life.restoreActiveWork([task]);
 const { reconciler } = fixture(done, [], { activeWork: () => life.activeWork(), emit: async input => {
  const event = normalizeRuntimeEvent("openclaw", input, envelope).event;
  const result = life.processDetailed(event); life.rollback(result.event); return false;
 } });
 assert.equal((await reconciler.reconcile()).reconciled, 0); assert.equal(life.status().activeRuns, 1);
});
