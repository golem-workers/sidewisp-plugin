import assert from "node:assert/strict";
import test from "node:test";
import { createOpenClawUserTaskLifecycle, openClawAgentEventInput, openClawActiveWorkCursor, parseOpenClawActiveWorkCursor } from "../src/adapters/openclaw/hooks.js";
import { normalizeRuntimeEvent } from "../src/core/normalize.js";

// Correlation and ordering from the original 4468 audit/trajectory/backend rows.
// Hook registration is reconstructed from the installed dispatch path; this is
// not a claim that the raw live AgentEvent object was retained.
const sessionId = "agent:main:telegram:group:-1003530052387";
const oldRun = "ecd600c0-87e3-4192-aef7-810e75f11efe";
const newRun = "831d332c-d698-4add-8d38-cac1f471c351";
const boundary = (messageId) => ({ type: "message.received", correlation: { sessionId, messageId }, details: { component: "before_dispatch" } });
let sequence = 0;
function native(runId, data, stream = "lifecycle") {
  const input = openClawAgentEventInput({ runId, sessionKey: stream === "tool" ? undefined : sessionId, stream, data });
  return normalizeRuntimeEvent("openclaw", input, { eventId: `sw_evt_overlap${++sequence}`, installationId: "sw_ins_overlap", sequence, occurredAt: "2026-10-13T01:22:49.129Z", observedAt: "2026-10-13T01:22:49.129Z", runtime: { version: "2026.9.8" }, source: { kind: "hook", adapterVersion: "0.2.67" } }).event;
}
const final = (messageId) => ({ type: "turn.completed", correlation: { sessionId, messageId }, details: { component: "final_reply" } });
const settled = (runId, data = {}) => native(runId, { phase: "end", startedAt: 1791854220773, endedAt: 1791854569129, stopReason: "end_turn", executionSettled: true, ...data });
function setup(options = {}) {
  const deferred = [];
  const tracker = createOpenClawUserTaskLifecycle({ onDeferred: e => { deferred.push(e); return true; }, ...options });
  tracker.process(boundary("4468"));
  tracker.process(native(oldRun, { phase: "start", startedAt: 1791854220773 }));
  tracker.process(native(oldRun, { phase: "start", name: "ask_user", toolCallId: "exec-bbbb6e65-226a-4bb3-b756-c2bb80452839" }, "tool"));
  tracker.process(native(oldRun, { phase: "result", name: "ask_user", toolCallId: "exec-bbbb6e65-226a-4bb3-b756-c2bb80452839", status: "completed" }, "tool"));
  // 4474 arrived at 01:22:18, before the original run settled at 01:22:49.
  tracker.process({ type: "message.received", correlation: { sessionId, messageId: "4474" }, details: { component: "message_observation" } });
  tracker.process(boundary("4474"));
  return { tracker, deferred };
}

test("4468 stays exact-bound when 4474 is admitted before its native settlement", () => {
  const { tracker, deferred } = setup();
  assert.deepEqual(tracker.activeWork().map(w => w.messageId), ["4468", "4474"]);
  assert.equal(tracker.process(settled(oldRun)), null);
  const terminal = tracker.process(final("4468"));
  assert.deepEqual([terminal.type, terminal.correlation.turnId], ["turn.completed", "4468"]);
  tracker.commit(terminal);
  tracker.process(settled(oldRun));
  assert.equal(tracker.process(final("4468")), null);
  assert.equal(deferred.length, 0);
  assert.equal(tracker.process(native(newRun, { phase: "start", startedAt: 1791854569559 })).correlation.turnId, "4474");
  assert.equal(tracker.process(final("4474")).correlation.turnId, "4474");
});

test("old exact final completes only old work when native settlement has not arrived", () => {
  const { tracker } = setup();
  assert.equal(tracker.process(final("4468")), null);
  assert.equal(tracker.process(settled(oldRun)).correlation.turnId, "4468");
  assert.equal(tracker.process(final("4468")), null);
  assert.deepEqual(tracker.activeWork().map(w => w.messageId), ["4474"]);
});

test("answer or intermediate/yielded lifecycle alone never completes old work", () => {
  for (const data of [{ executionSettled: false }, { stopReason: "tool_calls" }, { yielded: true, livenessState: "paused" }]) {
    const { tracker, deferred } = setup();
    tracker.process(settled(oldRun, data));
    assert.equal(deferred.length, 0);
    assert.ok(tracker.activeWork().some(w => w.messageId === "4468"));
  }
});

test("overlapping work cursor restores old exact bindings without making old work current", () => {
  const { tracker } = setup();
  const snapshot = parseOpenClawActiveWorkCursor(openClawActiveWorkCursor(5, tracker.activeWork()));
  for (const order of [snapshot, [...snapshot].reverse()]) {
    const deferred = [];
    const restored = createOpenClawUserTaskLifecycle({ onDeferred: e => { deferred.push(e); return true; } });
    assert.equal(restored.restoreActiveWork(order), 2);
    assert.equal(restored.process(settled(oldRun)), null);
    assert.equal(restored.process(final("4468")).correlation.turnId, "4468");
    assert.equal(restored.process(native(newRun, { phase: "start", startedAt: 1791854569559 })).correlation.turnId, "4474");
  }
});

test("detached cancellation keeps its correct subtype and a duplicate cannot close next work", () => {
  const { tracker } = setup();
  const event = settled(oldRun, { aborted: true, stopReason: "aborted" });
  const terminal = tracker.process(event);
  assert.deepEqual([terminal.type, terminal.correlation.turnId], ["turn.cancelled", "4468"]);
  tracker.commit(terminal);
  assert.equal(tracker.process(event), null);
  assert.equal(tracker.process(native(newRun, { phase: "start", startedAt: 1791854569559 })).correlation.turnId, "4474");
});

test("failed old terminal enqueue preserves both exact works and retries without selecting current", () => {
  const { tracker } = setup();
  tracker.process(settled(oldRun));
  const terminal = tracker.process(final("4468"));
  tracker.rollback(terminal);
  assert.deepEqual(tracker.activeWork().map(w => w.messageId), ["4468", "4474"]);
  const retried = tracker.process(final("4468"));
  assert.equal(retried.correlation.turnId, "4468");
  tracker.commit(retried);
  assert.equal(tracker.process(native(newRun, { phase: "start", startedAt: 1791854569559 })).correlation.turnId, "4474");
});

test("same run ID in another session and an unknown terminal cannot borrow old work", () => {
  const { tracker } = setup();
  const other = settled(oldRun);
  const otherTerminal = tracker.process({ ...other, correlation: { ...other.correlation, sessionId: "agent:main:telegram:group:other" } });
  assert.equal(otherTerminal.correlation.turnId, oldRun);
  tracker.process(settled("unknown-run"));
  assert.ok(tracker.activeWork().some(w => w.messageId === "4468"));
  assert.equal(tracker.process(settled(oldRun)), null);
  assert.equal(tracker.process(final("4468")).correlation.turnId, "4468");
});

test("admission at capacity cannot silently evict an executing old task", () => {
  const tracker = createOpenClawUserTaskLifecycle({ maxRuns: 1 });
  tracker.process(boundary("4468"));
  tracker.process(native(oldRun, { phase: "start", startedAt: 1791854220773 }));
  assert.equal(tracker.process(boundary("4474")), null);
  assert.deepEqual(tracker.activeWork().map(w => w.messageId), ["4468"]);
  assert.equal(tracker.activeWork()[0].detached, undefined);
});


test("unbound simultaneous run fails closed while two same-session works could own it", () => {
  const { tracker } = setup();
  assert.equal(tracker.process(native("ambiguous-run", { phase: "start", startedAt: 1791854560000 })), null);
  assert.ok(tracker.activeWork().every(w => !w.internalRunIds.includes("ambiguous-run")));
  tracker.process(settled(oldRun));
  tracker.process(final("4468"));
  assert.equal(tracker.process(native(newRun, { phase: "start", startedAt: 1791854569559 })).correlation.turnId, "4474");
});
