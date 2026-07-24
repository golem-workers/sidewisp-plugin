#!/usr/bin/env bash
set -euo pipefail
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$source_dir/install-command-runtime.sh" claude-code "${1:-}"
