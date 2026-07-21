import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("native Hermes plugin registers real upstream hooks and emits metadata only", () => {
  const script = String.raw`
import json, sys
sys.path.insert(0, "hermes")
import sidewisp
registered = {}
class Context:
    def register_hook(self, name, callback): registered[name] = callback
facts = []
sidewisp.set_sink(facts.append)
sidewisp.register(Context())
registered["post_tool_call"](session_id="session-1", tool_call_id="tool-1", outcome="failure", arguments={"password":"secret"}, result="private")
registered["api_request_error"](session_id="session-1", status=401, prompt="private prompt", completion="private completion")
print(json.dumps({"hooks": sorted(registered), "facts": facts}))
`;
  const result = spawnSync("python3", ["-c", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const hook of ["on_session_start", "on_session_end", "post_llm_call", "post_api_request", "api_request_error", "post_tool_call", "pre_gateway_dispatch", "post_approval_response", "subagent_start", "subagent_stop"]) {
    assert.ok(output.hooks.includes(hook), hook);
  }
  assert.equal(output.facts[0].kind, "tool_call_end");
  assert.equal(output.facts[1].httpStatus, 401);
  const serialized = JSON.stringify(output.facts);
  for (const privateValue of ["password", "secret", "private", "prompt", "completion", "arguments", "result"]) assert.equal(serialized.includes(privateValue), false);
});

test("Hermes hook identity is stable for recovery deduplication", () => {
  const script = String.raw`
import json, sys
sys.path.insert(0, "hermes")
import sidewisp
from sidewisp.recovery import _fact
facts=[]
sidewisp.set_sink(facts.append)
sidewisp.HOOKS["on_session_end"](session_id="session-1")
print(json.dumps([facts[0]["event_key"], _fact("session_end", "success", "session-1", 1)["event_key"]]))
`;
  const result = spawnSync("python3", ["-c", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const keys = JSON.parse(result.stdout);
  assert.equal(keys[0], keys[1]);
});

test("Hermes hook sink exceptions are swallowed", () => {
  const script = String.raw`
import sys
sys.path.insert(0, "hermes")
import sidewisp
sidewisp.set_sink(lambda _fact: (_ for _ in ()).throw(RuntimeError("boom")))
sidewisp.HOOKS["post_tool_call"](session_id="s", outcome="failure")
print("alive")
`;
  const result = spawnSync("python3", ["-c", script], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "alive");
});
