"""Bounded, read-only recovery for supported Hermes state and crash logs."""
from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONTRACT = "sidewisp.hermes-recovery.v1"
SUPPORTED_SCHEMA_MIN = 18
SUPPORTED_SCHEMA_MAX = 22
MAX_ROWS = 500
MAX_LOG_BYTES = 1024 * 1024
_CRASH_HEADER = re.compile(
    rb"^=== (?:unhandled|thread|turn-dispatcher) exception \xc2\xb7 "
    rb"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})",
    re.MULTILINE,
)
_GATEWAY_LIFECYCLE = re.compile(
    rb"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d{3} (?:INFO|WARNING) [^\n]*?: "
    rb"(Gateway running with \d+ platform\(s\)|Gateway started with no connected platforms|Gateway stopped(?: by an unexpected signal[^\n]*)?|Gateway stopped \(total teardown [^\n]*\))$",
    re.MULTILINE,
)


def _event_key(kind: str, identity: str) -> str:
    value = hashlib.sha256(f"hermes\0{kind}\0{identity}".encode()).hexdigest()[:32]
    return f"hermes:{value}"


def _fact(kind: str, outcome: str, session_id: str, observed_ms: int, **details: Any) -> dict[str, Any]:
    result: dict[str, Any] = {
        "kind": kind,
        "outcome": outcome,
        "observed_at_ms": observed_ms,
        "event_key": _event_key(kind, f"sessionId={session_id}"),
        "correlation": {"sessionId": session_id[:128]},
    }
    result.update(details)
    return result


def _read_sessions(db_path: Path, cursor: dict[str, Any], now_s: float, limit: int, stuck_seconds: int):
    facts: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    next_cursor = dict(cursor)
    if not db_path.is_file():
        diagnostics.append({"code": "state_db_missing"})
        return facts, next_cursor, diagnostics

    uri = f"file:{db_path.resolve()}?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=1.0)
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA busy_timeout=1000")
        version_row = connection.execute("SELECT version FROM schema_version LIMIT 1").fetchone()
        version = int(version_row[0]) if version_row else 0
        next_cursor["schema_version"] = version
        if not SUPPORTED_SCHEMA_MIN <= version <= SUPPORTED_SCHEMA_MAX:
            diagnostics.append({
                "code": "state_schema_unsupported",
                "schema_version": version,
                "supported_min": SUPPORTED_SCHEMA_MIN,
                "supported_max": SUPPORTED_SCHEMA_MAX,
            })
            connection.close()
            return facts, next_cursor, diagnostics

        after_started = float(cursor.get("started_at", 0))
        after_id = str(cursor.get("session_id", ""))
        rows = connection.execute(
            """SELECT id, started_at, ended_at, end_reason
               FROM sessions
               WHERE started_at > ? OR (started_at = ? AND id > ?)
               ORDER BY started_at, id LIMIT ?""",
            (after_started, after_started, after_id, limit),
        ).fetchall()
        connection.close()
        for session_id, started_at, ended_at, end_reason in rows:
            sid = str(session_id)
            started = float(started_at)
            if ended_at is not None:
                ended = float(ended_at)
                reason = str(end_reason or "completed")[:64]
                unclean = reason.lower() in {"crash", "error", "killed", "interrupted", "unclean"}
                facts.append(_fact(
                    "session_crashed" if unclean else "session_end",
                    "failure" if unclean else "success",
                    sid,
                    int(ended * 1000),
                    endReason=reason,
                ))
            elif now_s - started >= stuck_seconds:
                facts.append(_fact(
                    "task_queue_stalled", "failure", sid, int(now_s * 1000),
                    ageSeconds=int(now_s - started),
                ))
            next_cursor["started_at"] = started
            next_cursor["session_id"] = sid
        if len(rows) == limit:
            diagnostics.append({"code": "state_read_bounded", "limit": limit})
    except (sqlite3.Error, OSError, ValueError) as error:
        diagnostics.append({"code": "state_read_failed", "error_type": type(error).__name__})
    return facts, next_cursor, diagnostics


def _read_crashes(log_path: Path, cursor: dict[str, Any], now_s: float, crash_window_seconds: int):
    facts: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    next_cursor = dict(cursor)
    if not log_path.is_file():
        return facts, next_cursor, diagnostics
    try:
        size = log_path.stat().st_size
        previous = int(cursor.get("crash_log_offset", 0))
        if previous < 0 or previous > size:
            previous = 0
            diagnostics.append({"code": "crash_log_rotated"})
        start = max(previous, size - MAX_LOG_BYTES)
        if start > previous:
            diagnostics.append({"code": "crash_log_read_bounded", "max_bytes": MAX_LOG_BYTES})
        with log_path.open("rb") as handle:
            handle.seek(start)
            data = handle.read(MAX_LOG_BYTES)
        next_cursor["crash_log_offset"] = start + len(data)
        timestamps: list[float] = []
        for match in _CRASH_HEADER.finditer(data):
            parsed = datetime.strptime(match.group(1).decode(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            stamp = parsed.timestamp()
            timestamps.append(stamp)
            identity = f"{int(stamp)}:{start + match.start()}"
            facts.append({
                "kind": "runtime_crashed",
                "outcome": "failure",
                "observed_at_ms": int(stamp * 1000),
                "event_key": _event_key("runtime_crashed", identity),
            })
        recent = [stamp for stamp in timestamps if 0 <= now_s - stamp <= crash_window_seconds]
        if len(recent) >= 3:
            identity = f"{int(min(recent))}:{int(max(recent))}:{len(recent)}"
            facts.append({
                "kind": "runtime_crash_loop",
                "outcome": "failure",
                "observed_at_ms": int(max(recent) * 1000),
                "event_key": _event_key("runtime_crash_loop", identity),
                "crashCount": len(recent),
                "windowSeconds": crash_window_seconds,
            })
    except (OSError, ValueError) as error:
        diagnostics.append({"code": "crash_log_read_failed", "error_type": type(error).__name__})
    return facts, next_cursor, diagnostics


def _read_gateway(log_path: Path, cursor: dict[str, Any], now_s: float, restart_window_seconds: int):
    facts: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    next_cursor = dict(cursor)
    if not log_path.is_file():
        diagnostics.append({"code": "gateway_log_missing"})
        return facts, next_cursor, diagnostics
    try:
        size = log_path.stat().st_size
        previous = int(cursor.get("gateway_log_offset", 0))
        if previous < 0 or previous > size:
            previous = 0
            diagnostics.append({"code": "gateway_log_rotated"})
        start = max(previous, size - MAX_LOG_BYTES)
        if start > previous:
            diagnostics.append({"code": "gateway_log_read_bounded", "max_bytes": MAX_LOG_BYTES})
        with log_path.open("rb") as handle:
            handle.seek(start)
            data = handle.read(MAX_LOG_BYTES)
        next_cursor["gateway_log_offset"] = start + len(data)
        starts: list[float] = []
        for match in _GATEWAY_LIFECYCLE.finditer(data):
            stamp = datetime.strptime(match.group(1).decode(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
            message = match.group(2)
            is_start = message.startswith((b"Gateway running", b"Gateway started"))
            unexpected = message.startswith(b"Gateway stopped by an unexpected signal")
            kind = "runtime_started" if is_start else ("runtime_crashed" if unexpected else "runtime_stopped")
            identity = f"gateway:{int(stamp)}:{start + match.start()}"
            facts.append({
                "kind": kind,
                "outcome": "failure" if unexpected else "success",
                "observed_at_ms": int(stamp * 1000),
                "event_key": _event_key(kind, identity),
            })
            if is_start:
                starts.append(stamp)
        recent = [stamp for stamp in starts if 0 <= now_s - stamp <= restart_window_seconds]
        if len(recent) >= 3:
            identity = f"gateway:{int(min(recent))}:{int(max(recent))}:{len(recent)}"
            facts.append({
                "kind": "runtime_restart_loop",
                "outcome": "failure",
                "observed_at_ms": int(max(recent) * 1000),
                "event_key": _event_key("runtime_restart_loop", identity),
                "restartCount": len(recent),
                "windowSeconds": restart_window_seconds,
            })
    except (OSError, ValueError) as error:
        diagnostics.append({"code": "gateway_log_read_failed", "error_type": type(error).__name__})
    return facts, next_cursor, diagnostics


def recover(home: str | os.PathLike[str], cursor: dict[str, Any] | None = None, *, now_s: float | None = None,
            limit: int = MAX_ROWS, stuck_seconds: int = 1800, crash_window_seconds: int = 600) -> dict[str, Any]:
    """Recover safe lifecycle facts without mutating Hermes-owned files."""
    root = Path(home)
    current = dict(cursor or {})
    now = float(now_s if now_s is not None else datetime.now(tz=timezone.utc).timestamp())
    bounded_limit = max(1, min(int(limit), MAX_ROWS))
    session_facts, session_cursor, session_diagnostics = _read_sessions(
        root / "state.db", current, now, bounded_limit, max(1, int(stuck_seconds))
    )
    crash_facts, crash_cursor, crash_diagnostics = _read_crashes(
        root / "logs" / "tui_gateway_crash.log", session_cursor, now, max(1, int(crash_window_seconds))
    )
    gateway_facts, next_cursor, gateway_diagnostics = _read_gateway(
        root / "logs" / "gateway.log", crash_cursor, now, max(1, int(crash_window_seconds))
    )
    return {
        "contract": CONTRACT,
        "facts": session_facts + crash_facts + gateway_facts,
        "cursor": next_cursor,
        "diagnostics": session_diagnostics + crash_diagnostics + gateway_diagnostics,
    }
