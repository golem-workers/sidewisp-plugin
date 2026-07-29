#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: promote-production.sh <version> <sha256>" >&2
  exit 64
fi

version=$1
sha=$2
: "${SIDEWISP_PRODUCTION_HOST:?SIDEWISP_PRODUCTION_HOST is required}"
: "${SIDEWISP_PRODUCTION_USER:?SIDEWISP_PRODUCTION_USER is required}"
: "${SIDEWISP_PRODUCTION_SSH_KEY:?SIDEWISP_PRODUCTION_SSH_KEY is required}"
: "${SIDEWISP_PRODUCTION_KNOWN_HOSTS:?SIDEWISP_PRODUCTION_KNOWN_HOSTS is required}"

[[ "$version" =~ ^0\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid stable version: $version" >&2
  exit 64
}
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid SHA-256" >&2
  exit 64
}

ssh_dir=$(mktemp -d)
cleanup() {
  find "$ssh_dir" -type f -exec shred -u {} + 2>/dev/null || true
  rmdir "$ssh_dir" 2>/dev/null || true
}
trap cleanup EXIT

printf '%s\n' "$SIDEWISP_PRODUCTION_SSH_KEY" > "$ssh_dir/key"
printf '%s\n' "$SIDEWISP_PRODUCTION_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
chmod 600 "$ssh_dir/key" "$ssh_dir/known_hosts"

ssh \
  -i "$ssh_dir/key" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$ssh_dir/known_hosts" \
  "${SIDEWISP_PRODUCTION_USER}@${SIDEWISP_PRODUCTION_HOST}" \
  "promote ${version} ${sha}"
