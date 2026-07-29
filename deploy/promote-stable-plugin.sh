#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: promote-stable-plugin.sh <version> <sha256>" >&2
  exit 64
fi

version=$1
expected_sha=$2
env_file=${SIDEWISP_BACKEND_ENV_FILE:-/etc/sidewisp-backend/backend.env}
service=${SIDEWISP_BACKEND_SERVICE:-sidewisp-backend}
smoke_script=${SIDEWISP_BACKEND_SMOKE_SCRIPT:-/opt/sidewisp/backend/current/scripts/smoke.sh}
smoke_url=${SIDEWISP_BACKEND_SMOKE_URL:-http://127.0.0.1:3101}
spec="git:github.com/golem-workers/sidewisp-plugin@v${version}"

[[ "$version" =~ ^0\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid stable version: $version" >&2
  exit 64
}
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ ]] || {
  echo "invalid SHA-256" >&2
  exit 64
}
[[ -f "$env_file" ]] || {
  echo "backend environment not found: $env_file" >&2
  exit 66
}

for key in SIDEWISP_PLUGIN_STABLE_VERSION SIDEWISP_UPDATE_ROLLOUT_PERCENT; do
  [[ $(grep -c "^${key}=" "$env_file" || true) -eq 1 ]] || {
    echo "expected exactly one ${key} entry" >&2
    exit 65
  }
done

verify_dir=$(mktemp -d)
temp_env=$(mktemp "${env_file}.XXXXXX")
backup="${env_file}.pre-plugin-${version}-$(date -u +%Y%m%dT%H%M%SZ)"
cleanup() {
  rm -rf "$verify_dir"
  rm -f "$temp_env"
}
trap cleanup EXIT

artifact="$verify_dir/sidewisp-plugin-${version}.tgz"
curl --fail --location --silent --show-error \
  "https://github.com/golem-workers/sidewisp-plugin/releases/download/v${version}/sidewisp-plugin-${version}.tgz" \
  --output "$artifact"
actual_sha=$(sha256sum "$artifact" | awk '{print $1}')
[[ "$actual_sha" == "$expected_sha" ]] || {
  echo "package digest mismatch: expected ${expected_sha}, got ${actual_sha}" >&2
  exit 65
}

cp -a "$env_file" "$backup"
awk -v version="$version" -v spec="$spec" -v sha="$expected_sha" '
  BEGIN {
    wrote_spec = 0
    wrote_sha = 0
  }
  /^SIDEWISP_PLUGIN_STABLE_VERSION=/ {
    print "SIDEWISP_PLUGIN_STABLE_VERSION=" version
    next
  }
  /^SIDEWISP_UPDATE_ROLLOUT_PERCENT=/ {
    print "SIDEWISP_UPDATE_ROLLOUT_PERCENT=100"
    next
  }
  /^SIDEWISP_PLUGIN_STABLE_SPEC=/ {
    if (!wrote_spec) {
      print "SIDEWISP_PLUGIN_STABLE_SPEC=" spec
      wrote_spec = 1
    }
    next
  }
  /^SIDEWISP_PLUGIN_STABLE_SHA256=/ {
    if (!wrote_sha) {
      print "SIDEWISP_PLUGIN_STABLE_SHA256=" sha
      wrote_sha = 1
    }
    next
  }
  { print }
  END {
    if (!wrote_spec) print "SIDEWISP_PLUGIN_STABLE_SPEC=" spec
    if (!wrote_sha) print "SIDEWISP_PLUGIN_STABLE_SHA256=" sha
  }
' "$env_file" > "$temp_env"

chown --reference="$env_file" "$temp_env"
chmod --reference="$env_file" "$temp_env"
mv "$temp_env" "$env_file"

rollback() {
  cp -a "$backup" "$env_file"
  systemctl restart "$service"
}

if ! systemctl restart "$service"; then
  rollback
  exit 1
fi
if ! "$smoke_script" "$smoke_url"; then
  rollback
  "$smoke_script" "$smoke_url" || true
  exit 1
fi

printf 'promoted Sidewisp plugin v%s (%s)\n' "$version" "$expected_sha"
printf 'rollback environment: %s\n' "$backup"
