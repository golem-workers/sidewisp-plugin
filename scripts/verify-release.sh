#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
release_dir=$(mktemp -d)
trap 'rm -rf "$release_dir"' EXIT

cd "$repo_dir"
npm run check
archive=$(npm pack --pack-destination "$release_dir" --silent)
OPENCLAW_STATE_DIR="$release_dir/state" openclaw plugins install "$release_dir/$archive" --force >/dev/null
inspection=$(OPENCLAW_STATE_DIR="$release_dir/state" openclaw plugins inspect sidewisp --runtime --json)
node -e '
const value = JSON.parse(process.argv[1]);
if (value.plugin.status !== "loaded") throw new Error(`plugin status: ${value.plugin.status}`);
if (!value.services.includes("sidewisp-collector")) throw new Error("collector service missing");
if (value.tools.length || value.plugin.providerIds.length) throw new Error("plugin exposed an agent capability");
if (!value.gatewayMethods.includes("sidewisp.status") || !value.gatewayMethods.includes("sidewisp.supportBundle")) throw new Error("diagnostic methods missing");
' "$inspection"
