#!/usr/bin/env bash
set -euo pipefail
install_root="${SIDEWISP_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/sidewisp-hermes}"
if command -v systemctl >/dev/null; then
  systemctl --user disable --now sidewisp-hermes.service >/dev/null 2>&1 || true
  unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sidewisp-hermes.service"
  test ! -f "$unit" || mv "$unit" "$unit.disabled"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
elif test "$(uname -s)" = "Darwin"; then
  launchctl bootout "gui/$(id -u)/com.sidewisp.hermes-collector" >/dev/null 2>&1 || true
  plist="$HOME/Library/LaunchAgents/com.sidewisp.hermes-collector.plist"
  test ! -f "$plist" || mv "$plist" "$plist.disabled"
fi
echo "Collector stopped. Credentials and spool remain in the user state directory for recoverability."
