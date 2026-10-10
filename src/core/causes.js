import { readFileSync } from 'node:fs';
const catalog = JSON.parse(readFileSync(new URL('./cause-catalog.json', import.meta.url), 'utf8'));
export const CAUSE_CODES = new Set(catalog.causes.map(item => item.causeCode));
export function knownCause(value) { return typeof value === 'string' && CAUSE_CODES.has(value) ? value : null; }
const ALIASES = Object.freeze({
 ENOSPC:'disk_full', EDQUOT:'disk_full', EROFS:'read_only_filesystem', EMFILE:'file_descriptor_exhaustion', ENFILE:'file_descriptor_exhaustion', EADDRINUSE:'port_conflict',
 ENOMEM:'memory_pressure', ENOTFOUND:'dns_failure', EAI_AGAIN:'dns_failure', ECONNREFUSED:'connection_refused', ECONNRESET:'connection_reset', ETIMEDOUT:'network_timeout',
 CERT_HAS_EXPIRED:'tls_failure', ERR_TLS_CERT_ALTNAME_INVALID:'tls_failure', UNABLE_TO_VERIFY_LEAF_SIGNATURE:'tls_failure', DEPTH_ZERO_SELF_SIGNED_CERT:'tls_failure',
 ERR_WORKER_OUT_OF_MEMORY:'node_heap_oom', ERR_MODULE_NOT_FOUND:'dependency_missing', MODULE_NOT_FOUND:'dependency_missing',
 INSUFFICIENT_QUOTA:'provider_quota_exhausted', BILLING_HARD_LIMIT_REACHED:'provider_quota_exhausted', BILLING_NOT_ACTIVE:'provider_billing_disabled',
 INVALID_API_KEY:'provider_auth_failed', AUTHENTICATION_ERROR:'provider_auth_failed', CONTEXT_LENGTH_EXCEEDED:'model_context_overflow', MODEL_NOT_FOUND:'model_not_found',
 MODEL_NOT_SUPPORTED:'model_access_denied', OVERLOADED_ERROR:'provider_overloaded', RATE_LIMIT_EXCEEDED:'provider_rate_limited', RESOURCE_EXHAUSTED:'provider_quota_exhausted',
 SQLITE_CORRUPT:'filesystem_corrupt', SQLITE_READONLY:'read_only_filesystem', SQLITE_FULL:'disk_full',
});
export function classifyRuntimeCause(input = {}) {
 if(input.expected===true || input.outcome==='cancelled' || input.outcome==='policy-rejected')return null;
 const explicit=knownCause(input.causeCode);if(explicit)return explicit;
 const code=typeof input.code==='string'?input.code.slice(0,128).toUpperCase().replaceAll('-','_'):'';
 const direct=knownCause(code.toLowerCase());if(direct)return direct;
 if(ALIASES[code])return ALIASES[code];
 const kind=String(input.kind??'');const op=String(input.operation??'').toLowerCase();
 if(kind==='provider_error' || kind==='llm_provider_error'){
  if(input.httpStatus===401)return 'provider_auth_failed';if(input.httpStatus===403)return 'provider_permission_denied';
  if(input.httpStatus===429)return 'provider_rate_limited';if(input.httpStatus>=500)return 'provider_unavailable';
 }
 if(op.includes('memory')){
  if(code==='UNAVAILABLE')return 'memory_search_unavailable';if(code==='AUTH_FAILED')return 'memory_embedding_auth_failed';
 }
 if(op.includes('browser')){
  if(code==='TARGET_CLOSED'||code==='STALE_ELEMENT')return 'browser_target_stale';
  if(code==='CDP_UNAVAILABLE')return 'browser_cdp_unreachable';
  if(code==='TIMEOUT')return 'browser_navigation_timeout';
 }
 if(code==='APPROVAL_REQUIRED')return 'tool_approval_required';if(code==='APPROVAL_EXPIRED')return 'tool_approval_expired';
 if(code==='POLICY_DENIED')return 'tool_policy_denied';
 return null;
}
