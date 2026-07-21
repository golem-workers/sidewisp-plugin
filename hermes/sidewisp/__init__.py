"""Sidewisp observer-only Hermes plugin.

Callbacks deliberately construct bounded metadata facts. They never forward prompts,
completions, commands, tool arguments/results, or approval descriptions.
"""
from __future__ import annotations

import time
import hashlib
from typing import Any, Callable

_sink: Callable[[dict[str, Any]], None] = lambda _fact: None


def set_sink(sink: Callable[[dict[str, Any]], None]) -> None:
    """Bind the local Sidewisp collector bridge (used by the runtime host/tests)."""
    global _sink
    _sink = sink


def _safe_id(value: Any) -> str | None:
    if not isinstance(value, (str, int)):
        return None
    text = str(value)
    return text[:128] if text and all(c.isalnum() or c in "._:-/" for c in text) else None


def _emit(kind: str, outcome: str = "success", **kwargs: Any) -> None:
    fact: dict[str, Any] = {"kind": kind, "outcome": outcome, "observed_at_ms": int(time.time() * 1000)}
    correlation = {}
    for source, target in (("session_id", "sessionId"), ("run_id", "turnId"), ("tool_call_id", "toolCallId"), ("message_id", "messageId"), ("parent_session_id", "parentEventId")):
        value = _safe_id(kwargs.get(source))
        if value is not None:
            correlation[target] = value
    if correlation:
        fact["correlation"] = correlation
    identity = "|".join(f"{key}={correlation[key]}" for key in sorted(correlation)) or str(fact["observed_at_ms"])
    digest = hashlib.sha256(f"hermes\0{kind}\0{identity}".encode()).hexdigest()[:32]
    fact["event_key"] = f"hermes:{digest}"
    status = kwargs.get("status")
    if isinstance(status, int) and 100 <= status <= 599:
        fact["httpStatus"] = status
    duration = kwargs.get("duration_ms")
    if isinstance(duration, int) and 0 <= duration <= 86_400_000:
        fact["durationMs"] = duration
    try:
        _sink(fact)
    except Exception:
        # Observability must never alter Hermes execution.
        return


def _callback(kind: str, outcome: str = "success") -> Callable[..., None]:
    def observe(**kwargs: Any) -> None:
        try:
            metadata = dict(kwargs)
            explicit_outcome = metadata.pop("outcome", None)
            resolved = explicit_outcome or metadata.get("status") or outcome
            if resolved not in {"success", "failure", "cancelled", "timeout", "policy-rejected"}:
                resolved = outcome
            _emit(kind, str(resolved), **metadata)
        except Exception:
            return
    return observe


HOOKS = {
    "on_session_start": _callback("session_started"),
    "on_session_end": _callback("session_end"),
    "on_session_finalize": _callback("session_end"),
    "post_llm_call": _callback("llm_call_end"),
    "post_api_request": _callback("llm_call_end"),
    "api_request_error": _callback("llm_provider_error", "failure"),
    "post_tool_call": _callback("tool_call_end"),
    "pre_gateway_dispatch": _callback("message_received"),
    "post_approval_response": _callback("approval_end"),
    "subagent_start": _callback("subagent_started"),
    "subagent_stop": _callback("subagent_stopped"),
}


def register(ctx: Any) -> None:
    for hook_name, callback in HOOKS.items():
        ctx.register_hook(hook_name, callback)
