"""Sidewisp observer-only Hermes plugin.

Callbacks deliberately construct bounded metadata facts. They never forward prompts,
completions, commands, tool arguments/results, or approval descriptions.
"""
from __future__ import annotations

import time
import hashlib
from typing import Any, Callable

_CAUSE_CODES = frozenset(['agent_never_connected', 'agent_offline', 'agent_stale', 'collector_offline', 'gateway_unreachable', 'gateway_disconnected', 'gateway_auth_failed', 'gateway_wrong_target', 'dns_failure', 'connection_refused', 'connection_reset', 'tls_failure', 'proxy_failure', 'network_timeout', 'clock_skew', 'intermittent_transport', 'disk_warning', 'disk_critical', 'disk_full', 'inode_exhaustion', 'memory_pressure', 'swap_pressure', 'process_oom', 'node_heap_oom', 'cpu_saturation', 'event_loop_stalled', 'file_descriptor_exhaustion', 'process_limit_exhaustion', 'read_only_filesystem', 'filesystem_corrupt', 'permission_denied_filesystem', 'host_rebooted', 'systemd_unit_failed', 'restart_loop', 'supervisor_conflict', 'port_conflict', 'unsupported_os_or_arch', 'runtime_crashed', 'runtime_stopped_unexpectedly', 'runtime_start_failed', 'runtime_restart_failed', 'runtime_unhealthy_after_start', 'runtime_version_unsupported', 'runtime_adapter_unsupported', 'runtime_event_unmapped', 'runtime_event_normalization_failed', 'gateway_config_invalid', 'gateway_service_missing', 'gateway_service_mismatch', 'gateway_scope_missing', 'gateway_crash_loop_suppression', 'provider_auth_failed', 'provider_credential_expired', 'provider_permission_denied', 'provider_unavailable', 'provider_overloaded', 'provider_rate_limited', 'provider_quota_exhausted', 'provider_billing_disabled', 'provider_timeout', 'provider_malformed_response', 'model_not_found', 'model_access_denied', 'model_retired', 'model_context_overflow', 'provider_request_too_large', 'model_output_empty', 'model_refusal', 'all_auth_profiles_failed', 'all_model_fallbacks_failed', 'fallback_misconfigured', 'agent_run_terminal_timeout', 'idle_timeout_circuit_breaker', 'unknown_provider_failure', 'turn_failed', 'turn_timeout', 'turn_cancelled_unexpectedly', 'tool_failed', 'tool_timeout', 'tool_not_found', 'tool_invalid_input', 'tool_policy_denied', 'tool_approval_required', 'tool_approval_expired', 'tool_approval_mismatch', 'sandbox_unavailable', 'sandbox_start_failed', 'sandbox_resource_limit', 'exec_nonzero_exit', 'exec_signal_exit', 'exec_permission_denied', 'dependency_missing', 'dependency_version_mismatch', 'working_directory_missing', 'result_too_large', 'unknown_tool_failure', 'context_exhausted', 'compaction_failed', 'memory_flush_failed', 'memory_search_unavailable', 'memory_embedding_auth_failed', 'memory_embedding_unavailable', 'memory_index_stale', 'memory_index_corrupt', 'memory_profile_ambiguous', 'memory_source_unreadable', 'session_store_unavailable', 'session_store_corrupt', 'transcript_missing', 'orphan_transcript', 'session_binding_stale', 'session_resume_failed', 'session_expired', 'channel_not_configured', 'channel_credential_missing', 'channel_credential_rejected', 'channel_scope_missing', 'channel_disconnected', 'channel_network_failure', 'channel_rate_limited', 'channel_send_failed', 'channel_receive_failed', 'channel_webhook_invalid', 'channel_pairing_required', 'channel_sender_blocked', 'channel_mention_required', 'channel_privacy_mode', 'channel_target_invalid', 'channel_target_not_found', 'channel_message_too_large', 'channel_unsupported_media', 'channel_command_limit', 'channel_encryption_unverified', 'delivery_suppressed_expected', 'delivery_unknown_failure', 'schedule_failed', 'schedule_missed', 'schedule_overlapping', 'schedule_blocked', 'schedule_disabled', 'schedule_timezone_invalid', 'schedule_payload_invalid', 'schedule_target_invalid', 'schedule_stuck_running', 'heartbeat_not_firing', 'queue_stuck', 'queue_backpressure', 'queue_dead_lettered', 'queue_corrupt', 'queue_quota_exceeded', 'queue_locked', 'config_parse_failed', 'config_schema_invalid', 'config_reference_invalid', 'config_reload_failed', 'secret_missing', 'secret_resolution_failed', 'secret_scope_denied', 'secret_expired', 'identity_not_authenticated', 'identity_permission_denied', 'tenant_scope_violation', 'device_pairing_required', 'device_surface_approval_required', 'policy_denied', 'owner_not_configured', 'security_finding', 'certificate_or_signing_invalid', 'plugin_missing', 'plugin_load_failed', 'plugin_config_invalid', 'plugin_runtime_failed', 'plugin_dependency_missing', 'plugin_version_incompatible', 'skill_unavailable', 'skill_execution_failed', 'integration_auth_failed', 'integration_unavailable', 'integration_contract_changed', 'integration_rate_limited', 'integration_webhook_failed', 'node_offline', 'node_pairing_required', 'node_surface_unapproved', 'node_background_unavailable', 'node_permission_required', 'computer_control_disabled', 'accessibility_permission_required', 'location_disabled', 'system_run_denied', 'capability_not_declared', 'browser_not_running', 'browser_cdp_unreachable', 'browser_profile_invalid', 'browser_target_stale', 'browser_navigation_timeout', 'media_permission_required', 'media_decode_failed', 'file_transfer_failed', 'file_too_large', 'collector_not_enrolled', 'collector_credential_rejected', 'collector_credential_revoked', 'collector_endpoint_unreachable', 'collector_upload_retry', 'collector_upload_rejected', 'collector_invalid_ack', 'collector_backpressure', 'collector_dead_letter', 'collector_event_too_large', 'collector_spool_locked', 'collector_spool_corrupt', 'collector_spool_quota', 'collector_schema_newer', 'collector_hook_failed', 'collector_event_unsupported', 'collector_diagnostics_unsupported', 'collector_diagnostics_partial', 'collector_diagnostics_stale', 'collector_usage_failed', 'collector_clock_skew', 'monitoring_blind', 'update_available', 'update_preflight_failed', 'update_dependency_install_failed', 'update_build_failed', 'update_install_failed', 'update_doctor_failed', 'update_restart_unavailable', 'update_restart_failed', 'update_revision_mismatch', 'update_verification_timeout', 'update_rolled_back', 'update_rollback_failed', 'update_interrupted', 'update_plugin_target_unavailable', 'update_version_incompatible', 'collector_outdated', 'runtime_outdated', 'usage_collection_stale', 'usage_collection_partial', 'usage_delivery_failed', 'usage_budget_warning', 'usage_budget_exceeded', 'cost_anomaly', 'provider_limit_unknown', 'provider_limit_near', 'provider_limit_exhausted', 'pricing_unknown', 'unknown_failure', 'insufficient_evidence', 'unsupported_capability', 'stale_evidence', 'conflicting_evidence'])
_TYPED_ERROR_CODES = frozenset(["ENOSPC", "EDQUOT", "EROFS", "EMFILE", "ENFILE", "ENOMEM", "ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "INVALID_API_KEY", "INSUFFICIENT_QUOTA", "CONTEXT_LENGTH_EXCEEDED", "RATE_LIMIT_EXCEEDED"])

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
    cause = kwargs.get("cause_code", kwargs.get("causeCode"))
    if isinstance(cause, str) and cause in _CAUSE_CODES:
        fact["causeCode"] = cause
        if outcome == "success" and kwargs.get("signalState") in {"recovered", "observing"}:
            fact["signalState"] = kwargs["signalState"]
    code = kwargs.get("error_code", kwargs.get("code"))
    if isinstance(code, str) and code in _TYPED_ERROR_CODES:
        fact["code"] = code
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
