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
ha_unit_prefix=${SIDEWISP_HA_API_UNIT_PREFIX:-sidewisp-api@}
ha_env_dir=${SIDEWISP_HA_ENV_DIR:-/etc/sidewisp-backend}
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

declare -a ha_units=()
for slot in stable-b stable-a canary; do
  unit="${ha_unit_prefix}${slot}.service"
  if systemctl is-active --quiet "$unit"; then
    ha_units+=("$unit")
  fi
done
while IFS= read -r unit; do
  [[ -n "$unit" ]] || continue
  seen=0
  for known in "${ha_units[@]}"; do
    [[ "$known" == "$unit" ]] && seen=1
  done
  (( seen == 1 )) || ha_units+=("$unit")
done < <(systemctl list-units --type=service --state=running --no-legend --plain "${ha_unit_prefix}*.service" | awk '{print $1}')

legacy_active=0
systemctl is-active --quiet "$service" && legacy_active=1
if (( ${#ha_units[@]} > 0 && legacy_active == 1 )); then
  echo "legacy and HA Sidewisp API services are active simultaneously" >&2
  exit 65
fi
if (( ${#ha_units[@]} == 0 && legacy_active == 0 )); then
  echo "no active Sidewisp API service found" >&2
  exit 69
fi

restart_topology() {
  if (( ${#ha_units[@]} == 0 )); then
    systemctl restart "$service"
    "$smoke_script" "$smoke_url"
    return
  fi

  local unit instance env_path port
  for unit in "${ha_units[@]}"; do
    instance=${unit#"$ha_unit_prefix"}
    instance=${instance%.service}
    env_path="${ha_env_dir}/api-${instance}.env"
    port=$(sed -n 's/^PORT=//p' "$env_path")
    [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || {
      echo "invalid or missing PORT for ${unit}" >&2
      return 1
    }
    systemctl restart "$unit"
    "$smoke_script" "http://127.0.0.1:${port}"
  done
}

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
  restart_topology
}

if ! restart_topology; then
  rollback || true
  exit 1
fi

printf 'promoted Sidewisp plugin v%s (%s)\n' "$version" "$expected_sha"
printf 'rollback environment: %s\n' "$backup"
