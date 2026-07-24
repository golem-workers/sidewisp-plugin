#!/usr/bin/env bash
set -euo pipefail
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$source_dir/uninstall-command-runtime.sh" claude-code
