#!/usr/bin/env bash
set -euo pipefail

runtime_kind="${1:-}"
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
case "$runtime_kind" in
  codex) settings_file="${CODEX_HOME:-$HOME/.codex}/hooks.json" ;;
  claude-code) settings_file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" ;;
  *) echo "Runtime must be codex or claude-code" >&2; exit 2 ;;
esac
node "$source_dir/scripts/configure-command-runtime.mjs" remove "$runtime_kind" "$settings_file"
echo "Sidewisp hooks removed. Credentials, spool, and installed releases remain recoverable."
