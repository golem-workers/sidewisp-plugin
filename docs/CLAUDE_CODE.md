# Use Sidewisp with Claude Code

Sidewisp integrates with Claude Code through command hooks. The adapter is
observer-only and never reads transcripts, prompts, assistant messages, tool
arguments, tool results, commands, files, or provider error text.

## Requirements

- Node.js 22.22.3 or newer.
- Claude Code 2.1.218 or newer.
- A verified Sidewisp Plugin release archive or checkout.
- A one-time setup token for managed delivery.

Confirm the runtime:

```bash
claude --version
```

## Install

From the verified release directory:

```bash
SIDEWISP_ENDPOINT=https://api.sidewisp.com \
./scripts/install-claude-code.sh sw_setup_REPLACE_ME
```

The installer:

1. validates the Claude Code and Node.js versions;
2. exchanges the setup token without persisting it;
3. installs an immutable collector release in
   `~/.local/share/sidewisp-claude-code`;
4. stores credentials and the spool in
   `~/.local/state/sidewisp-claude-code`;
5. merges Sidewisp handlers into `~/.claude/settings.json`;
6. creates `settings.json.sidewisp-backup` once when a prior file exists.

Existing settings and hooks are preserved. Re-running the installer is
idempotent for Sidewisp handlers. Restart Claude Code after installation.

## Events

| Claude Code hook | Sidewisp event |
| --- | --- |
| `SessionStart` | `runtime.started` |
| `SessionEnd` | `runtime.stopped` |
| `UserPromptSubmit` | `turn.started` |
| `Stop` | `turn.completed` |
| `StopFailure` | `turn.failed` plus bounded provider or context failure |
| `PreToolUse` | `tool.started` |
| `PostToolUse` | `tool.completed` |
| `PostToolUseFailure` | `tool.failed` or expected `tool.cancelled` |
| `PermissionDenied` | expected `tool.cancelled` |

For `StopFailure`, only the documented error class is retained. Examples are
`rate_limit`, `authentication_failed`, `overloaded`, and
`max_output_tokens`. `error_details` and `last_assistant_message` are ignored.

For tool hooks, only `tool_name`, `tool_use_id`, `duration_ms`, and the
interrupt flag are eligible metadata. `tool_input`, `tool_response`, and
`error` text are ignored.

## Delivery and outages

Each hook atomically stages sanitized telemetry and returns success without
changing Claude Code behavior. A detached zero-LLM worker imports staged events
into the bounded SQLite spool and attempts signed HTTPS delivery.

Network, credential, or local writer-lock failures never block a prompt, tool,
or session. Events remain local and are retried by a later hook invocation.

## Update, rollback, and removal

Run the installer from a new verified release to update. Roll back by running
the previous release installer while preserving the state directory.

Remove Sidewisp handlers:

```bash
./scripts/uninstall-claude-code.sh
```

Removal keeps credentials, pending telemetry, installed releases, and all
unrelated Claude Code settings. Delete retained state manually only after
confirming that rollback and pending delivery are no longer needed.

## Troubleshooting

- No events: restart Claude Code and inspect `~/.claude/settings.json`.
- Hook error: verify the configured Node.js and `current` release paths still
  exist.
- Unsupported version: upgrade Claude Code, then rerun the installer.
- Pending events: check outbound HTTPS access to the configured endpoint.
- Custom config directory: use the same `CLAUDE_CONFIG_DIR` for install,
  update, and removal.
