---
name: native_openclaw_cron
description: Use the provisioned native OpenClaw cron helper on agent servers to add, list, run, and inspect cron jobs through the local OpenClaw CLI with the correct gateway URL and token already wired in. Use when cron creation, cron retries, or cron inspection is needed on the agent itself.
metadata: {"openclaw":{"requires":{"bins":["bash","node","openclaw"]}}}
---

# Native OpenClaw Cron

Use the provisioned helper in `~/.openclaw/workspace/cron-helper/cron-helper.sh`.

Do not build raw `openclaw cron ...` commands by hand when this helper already covers the job. It injects the live gateway URL and token from `~/.openclaw/openclaw.json` before calling the native OpenClaw CLI.
If the first CLI attempt returns `pairing required`, the helper waits briefly for relay auto-approve and retries the same native OpenClaw cron command inside the same helper invocation.

## Preflight

- Start with `~/.openclaw/workspace/cron-helper/cron-helper.sh gateway-info`.
- If gateway URL or token is missing, treat that as a real blocker and report the exact command plus stdout/stderr.

## Preferred commands

- Main-session reminder:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh add-system-event --name "job-name" --every 5m --text "message"`
- Isolated agent turn:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh add-agent-turn --name "job-name" --every 5m --message "instruction" --timeout-seconds 600`
- Internal isolated watchdog/supervision turn without chat delivery:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh add-agent-turn --name "job-name" --every 5m --message "instruction" --timeout-seconds 600 --no-deliver`
- List jobs:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh list --all --json`
- Run a job immediately:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh run <jobId>`
- Read run history:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh runs --id <jobId>`

## Raw escape hatch

- If you truly need a cron add/list/run/runs flag that the helper does not expose yet, use:
  - `~/.openclaw/workspace/cron-helper/cron-helper.sh add-raw ...`

The helper still injects the live `--url` and `--token`, so prefer it over calling `openclaw cron` directly.

Supported delivery passthrough flags on `add-system-event` and `add-agent-turn`:

- `--announce`
- `--no-deliver`
- `--channel <channel>`
- `--account <id>`
- `--to <dest>`
- `--best-effort-deliver`

## Failure rules

- If the helper reports missing gateway config, invalid cron args, or CLI failure, include the exact command and stderr in the blocker report.
- Do not implement your own outer retry loop for the normal pairing-required case before trying this helper once; the helper already retries that path internally.
- Do not replace this helper with a new ad-hoc cron wrapper unless the provisioned helper is clearly missing required behavior.
