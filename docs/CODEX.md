# Use Sidewisp with Codex

Sidewisp integrates with Codex through its stable command-hook lifecycle. The
adapter never reads transcripts and does not retain prompts, assistant
messages, tool arguments, or tool results.

## Requirements

- Node.js 22.22.3 or newer.
- Codex CLI 0.145.0 or newer.
- A verified Sidewisp Plugin release archive or checkout.
- A one-time setup token for managed delivery.

Confirm the runtime before installation:

```bash
codex --version
codex features list | grep '^hooks '
```

The `hooks` feature must report `stable`.

## Install

From the verified release directory:

```bash
SIDEWISP_ENDPOINT=https://api.sidewisp.com \
./scripts/install-codex.sh sw_setup_REPLACE_ME
```

The installer:

1. rejects unsupported Codex and Node.js versions;
2. exchanges the setup token without persisting it;
3. installs an immutable collector release in
   `~/.local/share/sidewisp-codex`;
4. stores credentials and the spool in
   `~/.local/state/sidewisp-codex`;
5. merges Sidewisp handlers into `~/.codex/hooks.json`;
6. creates `hooks.json.sidewisp-backup` once when a prior file exists.

Existing hook groups and handlers are preserved. Re-running the installer
updates Sidewisp handlers without creating duplicates.

Restart Codex, open `/hooks`, review the command, and trust the Sidewisp hook
definition. Codex intentionally skips new or changed non-managed hooks until
the user approves their exact hash.

## Events

| Codex hook | Sidewisp event |
| --- | --- |
| `SessionStart` | `runtime.started` |
| `SessionEnd` | `runtime.stopped` |
| `UserPromptSubmit` | `turn.started` |
| `Stop` | `turn.completed` |
| `PreToolUse` | `tool.started` |
| `PostToolUse` | `tool.completed`, `tool.failed`, or `tool.timeout` |

Codex does not currently expose a dedicated provider-failure lifecycle hook.
The adapter therefore reports `provider-hooks` as degraded instead of claiming
provider auth or rate-limit coverage.

The `PostToolUse` adapter inspects only bounded scalar result metadata such as
`exit_code`, `success`, `is_error`, and `status`. It never serializes the
actual `tool_input` or `tool_response`.

## Delivery and outages

Each hook writes one sanitized event into an owner-only local inbox and exits
without stdout or stderr. A detached zero-LLM worker imports events into the
SQLite spool and attempts an HMAC-signed HTTPS upload. Runtime execution is
never blocked by enrollment, storage, or network errors.

If upload is unavailable, events remain in the spool. A later hook invocation
retries delivery. Concurrent hooks use atomic per-event files before the
single-writer SQLite boundary.

## Update, rollback, and removal

Run the installer from the new verified release. It switches the `current`
symlink and replaces only Sidewisp hook handlers.

Rollback by running the previous verified release installer without deleting
the state directory.

Remove Sidewisp handlers:

```bash
./scripts/uninstall-codex.sh
```

Removal preserves credentials, pending telemetry, release files, and unrelated
Codex hooks for recoverability. Delete retained state manually only after
confirming that pending telemetry and rollback are no longer needed.

## Troubleshooting

- No events: restart Codex and approve the hook through `/hooks`.
- Hook warning at startup: inspect `~/.codex/hooks.json` and compare its
  command with the installed `current` release.
- Unsupported version: upgrade Codex, then rerun the installer.
- Pending events: check outbound HTTPS access to the configured endpoint.
- Custom state path: use the same `SIDEWISP_STATE_DIR` for install, update, and
  removal operations.
