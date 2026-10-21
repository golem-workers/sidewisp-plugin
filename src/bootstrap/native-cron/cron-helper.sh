#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_DIR/openclaw.json}"
CRON_RETRY_ATTEMPTS="${OPENCLAW_CRON_RETRY_ATTEMPTS:-6}"
CRON_RETRY_DELAY_SECONDS="${OPENCLAW_CRON_RETRY_DELAY_SECONDS:-2}"
OPENCLAW_PNPM_HOME="${OPENCLAW_PNPM_HOME:-$HOME/.local/share/pnpm}"

if [[ -d "$OPENCLAW_PNPM_HOME" ]]; then
  export PATH="$OPENCLAW_PNPM_HOME:$PATH"
fi

usage() {
  cat <<'EOF'
Usage:
  cron-helper.sh gateway-info
  cron-helper.sh inventory
  cron-helper.sh add-system-event --name <name> --every <duration> --text <message> [--disabled] [--announce|--no-deliver] [--channel <channel>] [--account <id>] [--to <dest>] [--best-effort-deliver]
  cron-helper.sh add-agent-turn --name <name> --every <duration> --message <instruction> [--timeout-seconds <n>] [--disabled] [--announce|--no-deliver] [--channel <channel>] [--account <id>] [--to <dest>] [--best-effort-deliver]
  cron-helper.sh add-raw <openclaw-cron-add-args...>
  cron-helper.sh list [openclaw-cron-list-args...]
  cron-helper.sh run <jobId> [openclaw-cron-run-args...]
  cron-helper.sh runs --id <jobId> [openclaw-cron-runs-args...]
  cron-helper.sh enable <jobId> [openclaw-cron-enable-args...]
  cron-helper.sh disable <jobId> [openclaw-cron-disable-args...]
  cron-helper.sh remove <jobId> [openclaw-cron-remove-args...]
EOF
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "Missing value for $flag" >&2
    exit 1
  fi
}

append_delivery_args() {
  local announce="$1"
  local no_deliver="$2"
  local channel="$3"
  local account="$4"
  local target="$5"
  local best_effort="$6"

  if [[ "$announce" -eq 1 && "$no_deliver" -eq 1 ]]; then
    echo "Cannot combine --announce and --no-deliver" >&2
    exit 1
  fi

  if [[ "$announce" -eq 1 ]]; then
    ADD_ARGS+=(--announce)
  fi
  if [[ "$no_deliver" -eq 1 ]]; then
    ADD_ARGS+=(--no-deliver)
  fi
  if [[ -n "$channel" ]]; then
    ADD_ARGS+=(--channel "$channel")
  fi
  if [[ -n "$account" ]]; then
    ADD_ARGS+=(--account "$account")
  fi
  if [[ -n "$target" ]]; then
    ADD_ARGS+=(--to "$target")
  fi
  if [[ "$best_effort" -eq 1 ]]; then
    ADD_ARGS+=(--best-effort-deliver)
  fi
}

is_pairing_required_output() {
  local text="$1"
  local lowered
  lowered="$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')"
  [[ "$lowered" == *"pairing required"* ]]
}

run_openclaw_cron_with_retry() {
  local stdout_file
  local stderr_file
  local attempt
  local exit_code
  local stdout_text
  local stderr_text
  local combined_text

  stdout_file="$(mktemp)"
  stderr_file="$(mktemp)"
  trap 'rm -f "$stdout_file" "$stderr_file"' RETURN

  for ((attempt = 1; attempt <= CRON_RETRY_ATTEMPTS; attempt += 1)); do
    if "$@" >"$stdout_file" 2>"$stderr_file"; then
      cat "$stdout_file"
      rm -f "$stdout_file" "$stderr_file"
      trap - RETURN
      return 0
    else
      # Capture the command failure before the if statement resets its status.
      exit_code=$?
    fi
    stdout_text="$(<"$stdout_file")"
    stderr_text="$(<"$stderr_file")"
    combined_text="${stderr_text}"$'\n'"${stdout_text}"

    if (( attempt < CRON_RETRY_ATTEMPTS )) && is_pairing_required_output "$combined_text"; then
      printf 'Pairing required on attempt %s/%s, waiting %ss for relay auto-approve before retrying.\n' \
        "$attempt" "$CRON_RETRY_ATTEMPTS" "$CRON_RETRY_DELAY_SECONDS" >&2
      sleep "$CRON_RETRY_DELAY_SECONDS"
      continue
    fi

    if [[ -n "$stdout_text" ]]; then
      printf '%s' "$stdout_text"
    fi
    if [[ -n "$stderr_text" ]]; then
      printf '%s' "$stderr_text" >&2
    fi
    rm -f "$stdout_file" "$stderr_file"
    trap - RETURN
    return "$exit_code"
  done

  rm -f "$stdout_file" "$stderr_file"
  trap - RETURN
  return 1
}

split_json_flag() {
  WANT_JSON=0
  FORWARDED_ARGS=()
  for arg in "$@"; do
    if [[ "$arg" == "--json" ]]; then
      WANT_JSON=1
      continue
    fi
    FORWARDED_ARGS+=("$arg")
  done
}

print_job_json_from_list() {
  local job_id="$1"
  local list_output
  list_output="$(run_openclaw_cron_with_retry openclaw cron list --all --json "${COMMON_ARGS[@]}")"
  JOB_ID="$job_id" LIST_OUTPUT="$list_output" node <<'NODE'
const jobId = process.env.JOB_ID || "";
const listOutput = process.env.LIST_OUTPUT || "";
const parsed = JSON.parse(listOutput);
const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
const job = jobs.find((entry) => entry && typeof entry === "object" && entry.id === jobId) ?? null;
if (!job) {
  console.error(`Cron job ${jobId} not found after update`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(job)}\n`);
NODE
}

print_remove_json() {
  local job_id="$1"
  node - "$job_id" <<'NODE'
const jobId = process.argv[2];
process.stdout.write(`${JSON.stringify({ ok: true, removed: true, jobId })}\n`);
NODE
}

print_run_json() {
  local job_id="$1"
  local run_output="${2:-}"
  JOB_ID="$job_id" RUN_OUTPUT="$run_output" node <<'NODE'
const jobId = process.env.JOB_ID || "";
const runOutput = process.env.RUN_OUTPUT || "";
const trimmed = runOutput.trim();

if (trimmed) {
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      process.stdout.write(`${JSON.stringify(parsed)}\n`);
      process.exit(0);
    }
  } catch {
    // Older OpenClaw builds print plain text for `cron run`; fall through to synthesis.
  }
}

const patterns = [
  /run(?:[ _-]?id)?\s*[:=]\s*"?([A-Za-z0-9._:-]+)"?/i,
  /\b([0-9a-f]{8}-[0-9a-f-]{27,})\b/i,
  /\b(run[_:-][A-Za-z0-9._:-]+)\b/i,
];
let runId = null;
for (const pattern of patterns) {
  const match = trimmed.match(pattern);
  if (match?.[1]) {
    runId = match[1];
    break;
  }
}
if (!runId) {
  runId = `${jobId}-${Date.now().toString(36)}`;
}

process.stdout.write(
  `${JSON.stringify({ ok: true, enqueued: true, runId, ran: null, runnable: true, reason: null })}\n`
);
NODE
}

print_empty_runs_json() {
  node - "$@" <<'NODE'
const args = process.argv.slice(2);
let limit = 50;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--limit") {
    const raw = args[index + 1];
    const parsed = Number.parseInt(raw ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      limit = parsed;
    }
    break;
  }
}
process.stdout.write(
  `${JSON.stringify({ entries: [], total: 0, offset: 0, limit, hasMore: false, nextOffset: null })}\n`
);
NODE
}

print_schedule_inventory_json() {
  local openclaw_list_output
  openclaw_list_output="$(run_openclaw_cron_with_retry openclaw cron list --all --json "${COMMON_ARGS[@]}")"
  OPENCLAW_LIST_OUTPUT="$openclaw_list_output" node <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const parsedOpenclaw = JSON.parse(process.env.OPENCLAW_LIST_OUTPUT || "{}");
const openclawJobs = Array.isArray(parsedOpenclaw?.jobs) ? parsedOpenclaw.jobs : [];
const etcCrontabPath = process.env.SYSTEM_CRON_ETC_CRONTAB_PATH || "/etc/crontab";
const cronDPath = process.env.SYSTEM_CRON_D_PATH || "/etc/cron.d";
const spoolPaths = (process.env.SYSTEM_CRON_SPOOL_PATHS || "/var/spool/cron/crontabs:/var/spool/cron")
  .split(":")
  .filter(Boolean);
const defaultTimezone =
  process.env.SYSTEM_CRON_DEFAULT_TIMEZONE ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "UTC";
const entries = [];
const seenFiles = new Set();

function fingerprint(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cleanEnvValue(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function addCronFile(filePath, format, owner) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!stat.isFile()) return;
  const resolved = path.resolve(filePath);
  if (seenFiles.has(resolved)) return;
  seenFiles.add(resolved);

  let timezone = defaultTimezone;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const envMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (envMatch) {
      if (envMatch[1] === "CRON_TZ" || envMatch[1] === "TZ") {
        timezone = cleanEnvValue(envMatch[2]);
      }
      return;
    }

    const tokens = trimmed.split(/\s+/);
    const macro = tokens[0]?.startsWith("@") ? tokens[0] : null;
    const scheduleFieldCount = macro ? 1 : 5;
    const userIndex = scheduleFieldCount;
    const commandIndex = format === "system" ? userIndex + 1 : userIndex;
    const schedule = macro ? macro : tokens.slice(0, 5).join(" ");
    const user = format === "system" ? tokens[userIndex] || null : owner;
    const hasCommand = tokens.length > commandIndex;
    const parseStatus = schedule && user && hasCommand ? "PENDING" : "INVALID";
    const digest = fingerprint(`${resolved}\n${index + 1}\n${rawLine}`);

    entries.push({
      sourceId: `system:${digest}`,
      sourcePath: resolved,
      line: index + 1,
      user,
      schedule,
      timezone,
      enabled: true,
      parseStatus,
      fingerprint: digest,
    });
  });
}

addCronFile(etcCrontabPath, "system", "root");

try {
  for (const name of fs.readdirSync(cronDPath)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    addCronFile(path.join(cronDPath, name), "system", "root");
  }
} catch {
  // Missing /etc/cron.d is valid on minimal images.
}

for (const spoolPath of spoolPaths) {
  let names;
  try {
    names = fs.readdirSync(spoolPath);
  } catch {
    continue;
  }
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
    addCronFile(path.join(spoolPath, name), "user", name);
  }
}

process.stdout.write(
  `${JSON.stringify({
    version: 1,
    collectedAt: new Date().toISOString(),
    openclawJobs,
    systemEntries: entries,
  })}\n`
);
NODE
}

run_cron_job_command_with_optional_args() {
  local subcommand="$1"
  local job_id="$2"
  shift 2
  if (( $# > 0 )); then
    run_openclaw_cron_with_retry openclaw cron "$subcommand" "$job_id" "$@" "${COMMON_ARGS[@]}"
  else
    run_openclaw_cron_with_retry openclaw cron "$subcommand" "$job_id" "${COMMON_ARGS[@]}"
  fi
}

read_gateway_value() {
  local field="$1"
  node - "$CONFIG_PATH" "$field" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
const field = process.argv[3];
const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
const gateway = parsed && typeof parsed === "object" ? parsed.gateway || {} : {};
const auth = gateway && typeof gateway === "object" ? gateway.auth || {} : {};
if (field === "url") {
  const remoteUrl =
    gateway &&
    typeof gateway === "object" &&
    gateway.remote &&
    typeof gateway.remote.url === "string" &&
    gateway.remote.url.trim()
      ? gateway.remote.url.trim()
      : "";
  const port = typeof gateway.port === "number" ? gateway.port : 18789;
  process.stdout.write(remoteUrl || `ws://127.0.0.1:${port}`);
  process.exit(0);
}
if (field === "token") {
  const token = auth && typeof auth.token === "string" ? auth.token.trim() : "";
  process.stdout.write(token);
  process.exit(0);
}
if (field === "mode") {
  const mode = auth && typeof auth.mode === "string" ? auth.mode.trim() : "";
  process.stdout.write(mode);
  process.exit(0);
}
process.exit(1);
NODE
}

GATEWAY_URL="$(read_gateway_value url)"
GATEWAY_TOKEN="$(read_gateway_value token)"
GATEWAY_MODE="$(read_gateway_value mode)"

if [[ -z "$GATEWAY_URL" || -z "$GATEWAY_TOKEN" ]]; then
  echo "Missing gateway URL or token in $CONFIG_PATH" >&2
  exit 1
fi

COMMON_ARGS=(--url "$GATEWAY_URL" --token "$GATEWAY_TOKEN")
WANT_JSON=0
FORWARDED_ARGS=()

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  usage
  exit 1
fi
shift

case "$COMMAND" in
  gateway-info)
    printf '{\n  "configPath": "%s",\n  "url": "%s",\n  "authMode": "%s",\n  "tokenPresent": true\n}\n' \
      "$CONFIG_PATH" "$GATEWAY_URL" "${GATEWAY_MODE:-unknown}"
    ;;

  inventory)
    print_schedule_inventory_json
    ;;

  add-system-event)
    NAME=""
    EVERY=""
    TEXT=""
    DISABLED=0
    ANNOUNCE=0
    NO_DELIVER=0
    DELIVERY_CHANNEL=""
    DELIVERY_ACCOUNT=""
    DELIVERY_TO=""
    BEST_EFFORT_DELIVER=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name)
          require_value "$1" "${2:-}"
          NAME="$2"
          shift 2
          ;;
        --every)
          require_value "$1" "${2:-}"
          EVERY="$2"
          shift 2
          ;;
        --text)
          require_value "$1" "${2:-}"
          TEXT="$2"
          shift 2
          ;;
        --disabled)
          DISABLED=1
          shift
          ;;
        --announce)
          ANNOUNCE=1
          shift
          ;;
        --no-deliver)
          NO_DELIVER=1
          shift
          ;;
        --channel)
          require_value "$1" "${2:-}"
          DELIVERY_CHANNEL="$2"
          shift 2
          ;;
        --account)
          require_value "$1" "${2:-}"
          DELIVERY_ACCOUNT="$2"
          shift 2
          ;;
        --to)
          require_value "$1" "${2:-}"
          DELIVERY_TO="$2"
          shift 2
          ;;
        --best-effort-deliver)
          BEST_EFFORT_DELIVER=1
          shift
          ;;
        *)
          echo "Unknown add-system-event flag: $1" >&2
          exit 1
          ;;
      esac
    done
    require_value "--name" "$NAME"
    require_value "--every" "$EVERY"
    require_value "--text" "$TEXT"
    ADD_ARGS=(--name "$NAME" --every "$EVERY" --session main --system-event "$TEXT" --json)
    if [[ "$DISABLED" -eq 1 ]]; then
      ADD_ARGS+=(--disabled)
    fi
    append_delivery_args "$ANNOUNCE" "$NO_DELIVER" "$DELIVERY_CHANNEL" "$DELIVERY_ACCOUNT" "$DELIVERY_TO" "$BEST_EFFORT_DELIVER"
    run_openclaw_cron_with_retry openclaw cron add "${ADD_ARGS[@]}" "${COMMON_ARGS[@]}"
    ;;

  add-agent-turn)
    NAME=""
    EVERY=""
    MESSAGE=""
    TIMEOUT_SECONDS="600"
    DISABLED=0
    ANNOUNCE=0
    NO_DELIVER=0
    DELIVERY_CHANNEL=""
    DELIVERY_ACCOUNT=""
    DELIVERY_TO=""
    BEST_EFFORT_DELIVER=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name)
          require_value "$1" "${2:-}"
          NAME="$2"
          shift 2
          ;;
        --every)
          require_value "$1" "${2:-}"
          EVERY="$2"
          shift 2
          ;;
        --message)
          require_value "$1" "${2:-}"
          MESSAGE="$2"
          shift 2
          ;;
        --timeout-seconds)
          require_value "$1" "${2:-}"
          TIMEOUT_SECONDS="$2"
          shift 2
          ;;
        --disabled)
          DISABLED=1
          shift
          ;;
        --announce)
          ANNOUNCE=1
          shift
          ;;
        --no-deliver)
          NO_DELIVER=1
          shift
          ;;
        --channel)
          require_value "$1" "${2:-}"
          DELIVERY_CHANNEL="$2"
          shift 2
          ;;
        --account)
          require_value "$1" "${2:-}"
          DELIVERY_ACCOUNT="$2"
          shift 2
          ;;
        --to)
          require_value "$1" "${2:-}"
          DELIVERY_TO="$2"
          shift 2
          ;;
        --best-effort-deliver)
          BEST_EFFORT_DELIVER=1
          shift
          ;;
        *)
          echo "Unknown add-agent-turn flag: $1" >&2
          exit 1
          ;;
      esac
    done
    require_value "--name" "$NAME"
    require_value "--every" "$EVERY"
    require_value "--message" "$MESSAGE"
    ADD_ARGS=(
      --name "$NAME"
      --every "$EVERY"
      --session isolated
      --message "$MESSAGE"
      --timeout-seconds "$TIMEOUT_SECONDS"
      --json
    )
    if [[ "$DISABLED" -eq 1 ]]; then
      ADD_ARGS+=(--disabled)
    fi
    append_delivery_args "$ANNOUNCE" "$NO_DELIVER" "$DELIVERY_CHANNEL" "$DELIVERY_ACCOUNT" "$DELIVERY_TO" "$BEST_EFFORT_DELIVER"
    run_openclaw_cron_with_retry openclaw cron add "${ADD_ARGS[@]}" "${COMMON_ARGS[@]}"
    ;;

  add-raw)
    run_openclaw_cron_with_retry openclaw cron add "$@" "${COMMON_ARGS[@]}"
    ;;

  list)
    run_openclaw_cron_with_retry openclaw cron list "$@" "${COMMON_ARGS[@]}"
    ;;

  run)
    if [[ $# -lt 1 ]]; then
      echo "Missing job id for run" >&2
      exit 1
    fi
    JOB_ID="$1"
    shift
    split_json_flag "$@"
    if [[ "$WANT_JSON" -eq 1 ]]; then
      run_output=""
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_output="$(run_cron_job_command_with_optional_args run "$JOB_ID" "${FORWARDED_ARGS[@]}")"
      else
        run_output="$(run_cron_job_command_with_optional_args run "$JOB_ID")"
      fi
      print_run_json "$JOB_ID" "$run_output"
    else
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args run "$JOB_ID" "${FORWARDED_ARGS[@]}"
      else
        run_cron_job_command_with_optional_args run "$JOB_ID"
      fi
    fi
    ;;

  runs)
    runs_output="$(run_openclaw_cron_with_retry openclaw cron runs "$@" "${COMMON_ARGS[@]}")"
    if [[ -n "${runs_output//[[:space:]]/}" ]]; then
      printf '%s' "$runs_output"
    else
      print_empty_runs_json "$@"
    fi
    ;;

  enable)
    if [[ $# -lt 1 ]]; then
      echo "Missing job id for enable" >&2
      exit 1
    fi
    JOB_ID="$1"
    shift
    split_json_flag "$@"
    if [[ "$WANT_JSON" -eq 1 ]]; then
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args enable "$JOB_ID" "${FORWARDED_ARGS[@]}" >/dev/null
      else
        run_cron_job_command_with_optional_args enable "$JOB_ID" >/dev/null
      fi
      print_job_json_from_list "$JOB_ID"
    else
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args enable "$JOB_ID" "${FORWARDED_ARGS[@]}"
      else
        run_cron_job_command_with_optional_args enable "$JOB_ID"
      fi
    fi
    ;;

  disable)
    if [[ $# -lt 1 ]]; then
      echo "Missing job id for disable" >&2
      exit 1
    fi
    JOB_ID="$1"
    shift
    split_json_flag "$@"
    if [[ "$WANT_JSON" -eq 1 ]]; then
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args disable "$JOB_ID" "${FORWARDED_ARGS[@]}" >/dev/null
      else
        run_cron_job_command_with_optional_args disable "$JOB_ID" >/dev/null
      fi
      print_job_json_from_list "$JOB_ID"
    else
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args disable "$JOB_ID" "${FORWARDED_ARGS[@]}"
      else
        run_cron_job_command_with_optional_args disable "$JOB_ID"
      fi
    fi
    ;;

  remove)
    if [[ $# -lt 1 ]]; then
      echo "Missing job id for remove" >&2
      exit 1
    fi
    JOB_ID="$1"
    shift
    split_json_flag "$@"
    if [[ "$WANT_JSON" -eq 1 ]]; then
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args remove "$JOB_ID" "${FORWARDED_ARGS[@]}" >/dev/null
      else
        run_cron_job_command_with_optional_args remove "$JOB_ID" >/dev/null
      fi
      print_remove_json "$JOB_ID"
    else
      if (( ${#FORWARDED_ARGS[@]} > 0 )); then
        run_cron_job_command_with_optional_args remove "$JOB_ID" "${FORWARDED_ARGS[@]}"
      else
        run_cron_job_command_with_optional_args remove "$JOB_ID"
      fi
    fi
    ;;

  *)
    usage
    exit 1
    ;;
esac
