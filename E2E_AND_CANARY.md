# E2E and controlled canary evidence

Evidence date: 2026-07-21. All scenarios are deterministic and make zero LLM/provider calls.

## OpenClaw

- Public package installed on the real Checker host running OpenClaw `2026.7.1-2` in a `sidewisp-e2e-openclaw-*` temporary state directory.
- Runtime inspection returned `loaded`, service `sidewisp-collector`, methods `sidewisp.status` and `sidewisp.supportBundle`, and no tools or providers.
- The temporary directory was automatically removed; the production Checker configuration and gateway were not changed.
- `npm run e2e:openclaw` reproduces packaging, isolated install, runtime inspection, capability checks, and cleanup locally.
- Unit/recovery suites inject tool failure, config/enrollment failure, delivery rejection, restart, reconnect, truncated JSONL, and acknowledgement replay.

## Hermes

- `npm run e2e:hermes` loads the adapter against Hermes upstream commit `7651764ce` and checks every registered hook against upstream `VALID_HOOKS`.
- It injects session start, tool failure, provider failure, observer sink failure, gateway crash, session crash, restart/recovery state, and cleanup in a `sidewisp-e2e-hermes-*` temporary directory.
- Observer failures are swallowed, private inputs never enter emitted facts, and recovery is read-only.

## Codex

- Verified against Codex CLI 0.145.0, where the `hooks` feature reports
  `stable`.
- Fixtures cover the documented `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` wire fields.
- Installer tests preserve existing `hooks.json` handlers, stay idempotent,
  enforce the runtime baseline, and remove only Sidewisp handlers.
- A subprocess test invokes the real Sidewisp hook command and proves that an
  upload outage leaves sanitized telemetry in the SQLite spool without stdout,
  stderr, or runtime failure.

## Claude Code

- Verified against the official Claude Code 2.1.218 hook contract.
- Fixtures cover lifecycle, turn, successful/failed tool, permission-denial,
  and provider/context failure events.
- Tests prove that `prompt`, `tool_input`, `tool_response`, `error_details`,
  transcripts, and assistant text never enter normalized telemetry.
- Installer tests preserve existing `settings.json` fields and handlers,
  enforce the tested baseline, and stay idempotent.

## Controlled canary and rollout gate

`npm run canary:check` evaluates the versioned `sidewisp.canary.v1` gate. The reviewed deterministic corpus contains 200 expected incident transitions with zero false positives, p95 visibility latency of 26 seconds, offline detection in 70 seconds at a 30-second heartbeat, maximum 0.8% CPU, 46 MiB resident memory, zero forbidden payload findings, and zero inference calls.

The evaluator enables stages 5% → 25% → 100% only when every security, privacy, OpenClaw E2E, Hermes E2E, backup, and rollback evidence flag is present. Any failed metric returns no rollout stages and exact stop criteria. This is controlled release evidence, not a claim of a multi-day production observation window.
