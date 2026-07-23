#!/usr/bin/env bash
set -euo pipefail

endpoint="${SIDEWISP_ENDPOINT:-https://staging-api.sidewisp.com}"
setup_token="${SIDEWISP_SETUP_TOKEN:-${1:-}}"
source_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
install_root="${SIDEWISP_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/sidewisp-hermes}"
state_dir="${SIDEWISP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/sidewisp-hermes}"
runtime_dir="${HERMES_SOURCE_DIR:-$HOME/hermes-agent}"

case "$endpoint" in https://*) ;; *) echo "SIDEWISP_ENDPOINT must use HTTPS" >&2; exit 2 ;; esac
case "$setup_token" in sw_setup_????????????????????????????????*) ;; *) echo "A valid one-time Sidewisp setup token is required" >&2; exit 2 ;; esac
command -v node >/dev/null || { echo "Node.js is required" >&2; exit 2; }
test -d "$runtime_dir" || { echo "Hermes runtime not found at $runtime_dir" >&2; exit 2; }

mkdir -p -m 700 "$install_root" "$state_dir"
release_dir="$install_root/releases/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p -m 700 "$release_dir"
cp -R "$source_dir/index.js" "$source_dir/config.js" "$source_dir/package.json" "$source_dir/src" "$source_dir/scripts" "$release_dir/"
chmod -R go-rwx "$release_dir" "$state_dir"
ln -sfn "$release_dir" "$install_root/current"

SIDEWISP_ENDPOINT="$endpoint" SIDEWISP_STATE_DIR="$state_dir" SIDEWISP_SETUP_TOKEN="$setup_token" \
  node "$release_dir/scripts/enroll-hermes.mjs"
unset setup_token SIDEWISP_SETUP_TOKEN

if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p -m 700 "$unit_dir"
  cat >"$unit_dir/sidewisp-hermes.service" <<EOF
[Unit]
Description=Sidewisp Hermes metadata-only health collector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$install_root/current
Environment=NODE_ENV=production
Environment=SIDEWISP_ENDPOINT=$endpoint
Environment=SIDEWISP_STATE_DIR=$state_dir
Environment=HERMES_SOURCE_DIR=$runtime_dir
Environment=SIDEWISP_HEARTBEAT_INTERVAL_MS=30000
ExecStart=$(command -v node) $install_root/current/scripts/hermes-canary-daemon.mjs
Restart=always
RestartSec=3
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$state_dir
MemoryMax=128M
CPUQuota=50%

[Install]
WantedBy=default.target
EOF
  chmod 600 "$unit_dir/sidewisp-hermes.service"
  systemctl --user daemon-reload
  systemctl --user enable --now sidewisp-hermes.service
  systemctl --user is-active --quiet sidewisp-hermes.service
  echo "Sidewisp Hermes collector installed and running (systemd user service)."
elif test "$(uname -s)" = "Darwin"; then
  agent_dir="$HOME/Library/LaunchAgents"
  mkdir -p "$agent_dir"
  plist="$agent_dir/com.sidewisp.hermes-collector.plist"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.sidewisp.hermes-collector</string>
<key>ProgramArguments</key><array><string>$(command -v node)</string><string>$install_root/current/scripts/hermes-canary-daemon.mjs</string></array>
<key>WorkingDirectory</key><string>$install_root/current</string>
<key>EnvironmentVariables</key><dict>
<key>NODE_ENV</key><string>production</string><key>SIDEWISP_ENDPOINT</key><string>$endpoint</string>
<key>SIDEWISP_STATE_DIR</key><string>$state_dir</string><key>HERMES_SOURCE_DIR</key><string>$runtime_dir</string>
<key>SIDEWISP_HEARTBEAT_INTERVAL_MS</key><string>30000</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$state_dir/collector.log</string>
<key>StandardErrorPath</key><string>$state_dir/collector.error.log</string>
</dict></plist>
EOF
  chmod 600 "$plist"
  launchctl bootout "gui/$(id -u)/com.sidewisp.hermes-collector" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl kickstart -k "gui/$(id -u)/com.sidewisp.hermes-collector"
  echo "Sidewisp Hermes collector installed and running (macOS LaunchAgent)."
else
  echo "Unsupported service manager; enrollment completed but collector was not started" >&2
  exit 3
fi
