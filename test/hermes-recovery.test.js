import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repo = new URL("..", import.meta.url);

function runRecovery(home, options = {}) {
  const script = String.raw`
import json, sys
sys.path.insert(0, "hermes")
from sidewisp.recovery import recover
print(json.dumps(recover(sys.argv[1], now_s=float(sys.argv[2]), limit=int(sys.argv[3]), stuck_seconds=300, crash_window_seconds=600), sort_keys=True))
`;
  const result = spawnSync("python3", ["-c", script, home, String(options.now ?? 1784635800), String(options.limit ?? 500)], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function makeState(home, schemaVersion = 22) {
  const script = String.raw`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.executescript("CREATE TABLE schema_version(version INTEGER NOT NULL); CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT);")
db.execute("INSERT INTO schema_version VALUES (?)", (int(sys.argv[2]),))
db.executemany("INSERT INTO sessions VALUES (?,?,?,?)", [
 ("clean",1784635000,1784635010,"completed"),
 ("crashed",1784635100,1784635110,"crash"),
 ("stuck",1784635200,None,None)])
db.commit()
`;
  const result = spawnSync("python3", ["-c", script, join(home, "state.db"), String(schemaVersion)], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("Hermes recovery reads supported state read-only and classifies shutdowns", () => {
  const home = mkdtempSync(join(tmpdir(), "sidewisp-hermes-"));
  makeState(home);
  const before = readFileSync(join(home, "state.db"));
  const beforeMtime = statSync(join(home, "state.db")).mtimeMs;
  const output = runRecovery(home);
  assert.deepEqual(output.facts.slice(0, 3).map(({ kind, outcome }) => [kind, outcome]), [
    ["session_end", "success"], ["session_crashed", "failure"], ["task_queue_stalled", "failure"],
  ]);
  assert.equal(output.cursor.schema_version, 22);
  assert.deepEqual(readFileSync(join(home, "state.db")), before);
  assert.equal(statSync(join(home, "state.db")).mtimeMs, beforeMtime);
  assert.equal(JSON.stringify(output).includes("content"), false);
});

test("Hermes recovery reports schema drift explicitly and performs no unsafe fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "sidewisp-hermes-"));
  makeState(home, 23);
  const output = runRecovery(home);
  assert.equal(output.facts.length, 0);
  assert.equal(output.diagnostics[0].code, "state_schema_unsupported");
  assert.equal(output.diagnostics[0].schema_version, 23);
});

test("Hermes recovery detects deterministic crash loops and advances log cursor", () => {
  const home = mkdtempSync(join(tmpdir(), "sidewisp-hermes-"));
  makeState(home);
  mkdirSync(join(home, "logs"));
  const log = [
    "=== unhandled exception · 2026-07-21 09:22:00 ===\ntrace private-a",
    "=== thread exception · 2026-07-21 09:23:00 · thread=x ===\ntrace private-b",
    "=== turn-dispatcher exception · 2026-07-21 09:24:00 · sid=secret ===\ntrace private-c",
  ].join("\n");
  writeFileSync(join(home, "logs", "tui_gateway_crash.log"), log);
  const output = runRecovery(home, { now: 1784626200 });
  assert.equal(output.facts.filter(({ kind }) => kind === "runtime_crashed").length, 3);
  assert.equal(output.facts.at(-1).kind, "runtime_crash_loop");
  assert.equal(output.facts.at(-1).crashCount, 3);
  assert.equal(JSON.stringify(output).includes("private"), false);
  assert.equal(output.cursor.crash_log_offset, Buffer.byteLength(log));
});

test("Hermes recovery classifies gateway lifecycle and restart loops", () => {
  const home = mkdtempSync(join(tmpdir(), "sidewisp-hermes-"));
  makeState(home);
  mkdirSync(join(home, "logs"));
  const log = [
    "2026-07-21 09:22:00,100 INFO gateway.run: Gateway running with 1 platform(s)",
    "2026-07-21 09:23:00,100 INFO gateway.run: Gateway stopped (total teardown 0.20s)",
    "2026-07-21 09:24:00,100 INFO gateway.run: Gateway started with no connected platforms",
    "2026-07-21 09:25:00,100 WARNING gateway.run: Gateway stopped by an unexpected signal — persisting state",
    "2026-07-21 09:26:00,100 INFO gateway.run: Gateway running with 1 platform(s)",
  ].join("\n");
  writeFileSync(join(home, "logs", "gateway.log"), log);
  const output = runRecovery(home, { now: 1784626200 });
  assert.deepEqual(output.facts.slice(-6).map(({ kind }) => kind), [
    "runtime_started", "runtime_stopped", "runtime_started", "runtime_crashed", "runtime_started", "runtime_restart_loop",
  ]);
  assert.equal(output.cursor.gateway_log_offset, Buffer.byteLength(log));
  assert.equal(JSON.stringify(output).includes("persisting state"), false);
});

test("Hermes recovery applies the hard row bound", () => {
  const home = mkdtempSync(join(tmpdir(), "sidewisp-hermes-"));
  makeState(home);
  const output = runRecovery(home, { limit: 2 });
  assert.equal(output.facts.length, 2);
  assert.ok(output.diagnostics.some(({ code }) => code === "state_read_bounded"));
});
