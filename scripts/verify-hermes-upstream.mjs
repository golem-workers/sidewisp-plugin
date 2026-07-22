#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const upstream = path.resolve(process.env.HERMES_SOURCE_DIR || "../hermes-agent-upstream");
const pluginRoot = path.resolve(new URL("..", import.meta.url).pathname);
assert.ok(fs.existsSync(path.join(upstream, "hermes_cli", "plugins.py")), `Hermes source not found: ${upstream}`);

const script = String.raw`
import importlib.util, json, pathlib, sqlite3, sys, tempfile
upstream, plugin_root = map(pathlib.Path, sys.argv[1:3])
sys.path.insert(0, str(upstream))
sys.path.insert(0, str(plugin_root / "hermes"))
from hermes_cli.plugins import VALID_HOOKS
import sidewisp
from sidewisp.recovery import recover
missing = sorted(set(sidewisp.HOOKS) - set(VALID_HOOKS))
if missing: raise RuntimeError(f"unsupported hooks: {missing}")
registered = {}
class Context:
    def register_hook(self, name, callback): registered[name] = callback
facts = []
sidewisp.set_sink(facts.append)
sidewisp.register(Context())
registered["on_session_start"](session_id="sidewisp-e2e-hermes-session")
registered["post_tool_call"](session_id="sidewisp-e2e-hermes-session", tool_call_id="tool-1", outcome="failure", args={"secret":"forbidden"}, result="forbidden")
registered["api_request_error"](session_id="sidewisp-e2e-hermes-session", status=503, prompt="forbidden")
sidewisp.set_sink(lambda _fact: (_ for _ in ()).throw(RuntimeError("injected sink failure")))
registered["post_tool_call"](session_id="sidewisp-e2e-hermes-session", outcome="failure")
with tempfile.TemporaryDirectory(prefix="sidewisp-e2e-hermes-") as temp:
    root = pathlib.Path(temp)
    (root / "logs").mkdir()
    db = sqlite3.connect(root / "state.db")
    db.execute("CREATE TABLE schema_version(version INTEGER)")
    db.execute("INSERT INTO schema_version VALUES (20)")
    db.execute("CREATE TABLE sessions(id TEXT, started_at REAL, ended_at REAL, end_reason TEXT)")
    db.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", ("sidewisp-e2e-hermes-session", 100.0, 110.0, "crash"))
    db.commit(); db.close()
    (root / "logs" / "gateway.log").write_text("2026-07-21 08:00:00,000 INFO gateway: Gateway running with 1 platform(s)\n2026-07-21 08:00:01,000 WARNING gateway: Gateway stopped by an unexpected signal TERM\n")
    (root / "logs" / "tui_gateway_crash.log").write_text("=== unhandled exception · 2026-07-21 08:00:01\n")
    recovered = recover(root, now_s=1784620810)
print(json.dumps({"hooks": sorted(registered), "facts": facts, "recovered": recovered}))
`;
const result = spawnSync("python3", ["-c", script, upstream, pluginRoot], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
const evidence = JSON.parse(result.stdout);
assert.ok(evidence.facts.some(({ kind }) => kind === "session_started"));
assert.ok(evidence.facts.some(({ kind, outcome }) => kind === "tool_call_end" && outcome === "failure"));
assert.ok(evidence.facts.some(({ kind, httpStatus }) => kind === "llm_provider_error" && httpStatus === 503));
assert.ok(evidence.recovered.facts.some(({ kind }) => kind === "session_crashed"));
assert.ok(evidence.recovered.facts.some(({ kind }) => kind === "runtime_crashed"));
const serialized = JSON.stringify(evidence);
for (const forbidden of ["forbidden", "prompt", "secret", "args", "result"]) assert.equal(serialized.includes(forbidden), false);
if (process.env.SIDEWISP_HERMES_EVIDENCE_FILE) {
  fs.writeFileSync(process.env.SIDEWISP_HERMES_EVIDENCE_FILE, `${JSON.stringify(evidence)}\n`, { mode: 0o600, flag: "wx" });
}
console.log(JSON.stringify({ runtime: "hermes", upstream, hooks: evidence.hooks.length, emittedFacts: evidence.facts.length, recoveredFacts: evidence.recovered.facts.length, inferenceCalls: 0, temporaryResourcesCleaned: true }));
