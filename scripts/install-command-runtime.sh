#!/usr/bin/env bash
set -euo pipefail

runtime_kind="${1:-}"
setup_token="${SIDEWISP_SETUP_TOKEN:-${2:-}}"
endpoint="${SIDEWISP_ENDPOINT:-https://api.sidewisp.com}"
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
adapter_version="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$source_dir/package.json")"

case "$endpoint" in https://*) ;; *) echo "SIDEWISP_ENDPOINT must use HTTPS" >&2; exit 2 ;; esac
case "$runtime_kind" in
  codex)
    runtime_binary="$(command -v codex || true)"
    install_root="${SIDEWISP_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/sidewisp-codex}"
    state_dir="${SIDEWISP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/sidewisp-codex}"
    settings_file="${CODEX_HOME:-$HOME/.codex}/hooks.json"
    test -n "$runtime_binary" || { echo "codex runtime is required" >&2; exit 2; }
    runtime_version="$("$runtime_binary" --version 2>/dev/null | sed -n 's/^codex-cli //p' | head -n 1)"
    ;;
  claude-code)
    runtime_binary="$(command -v claude || true)"
    install_root="${SIDEWISP_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/sidewisp-claude-code}"
    state_dir="${SIDEWISP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/sidewisp-claude-code}"
    settings_file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
    test -n "$runtime_binary" || { echo "claude-code runtime is required" >&2; exit 2; }
    runtime_version="$("$runtime_binary" --version 2>/dev/null | sed -nE 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' | head -n 1)"
    ;;
  *) echo "Runtime must be codex or claude-code" >&2; exit 2 ;;
esac

test -n "$runtime_version" || { echo "Unable to determine $runtime_kind version" >&2; exit 2; }
command -v node >/dev/null || { echo "Node.js is required" >&2; exit 2; }
credential_file="$state_dir/sidewisp/installation.json"
if test ! -f "$credential_file"; then
  case "$setup_token" in sw_setup_????????????????????????????????*) ;; *) echo "A valid one-time Sidewisp setup token is required for first install" >&2; exit 2 ;; esac
fi

mkdir -p -m 700 "$install_root" "$state_dir"
release_dir="$install_root/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -m 700 "$release_dir"
cp -R \
  "$source_dir/index.js" \
  "$source_dir/config.js" \
  "$source_dir/package.json" \
  "$source_dir/src" \
  "$source_dir/scripts" \
  "$release_dir/"
chmod -R go-rwx "$release_dir" "$state_dir"
ln -sfn "$release_dir" "$install_root/current"

SIDEWISP_ENDPOINT="$endpoint" SIDEWISP_STATE_DIR="$state_dir" SIDEWISP_SETUP_TOKEN="$setup_token" \
  node "$release_dir/scripts/enroll-command-runtime.mjs"
unset setup_token SIDEWISP_SETUP_TOKEN

node "$release_dir/scripts/configure-command-runtime.mjs" install \
  "$runtime_kind" "$settings_file" "$install_root" "$state_dir" "$endpoint" \
  "$runtime_version" "$adapter_version" "$(command -v node)"

if test "$runtime_kind" = "codex"; then
  echo "Sidewisp Codex adapter installed. Restart Codex, open /hooks, and trust the Sidewisp hooks."
else
  echo "Sidewisp Claude Code adapter installed. Restart Claude Code."
fi
