import { classifyRuntimeCause } from '../core/causes.js';

// Inspect native exception text only locally. Emit closed categories, never the
// exception, prompt, transcript, provider response, path or credential itself.
export function scheduleFailureSummary(stage, error, outcome) {
  const code = error?.code ?? outcome?.code;
  let cause = classifyRuntimeCause({code, causeCode:error?.causeCode ?? outcome?.causeCode});
  const nativeText = typeof outcome?.error === 'string' ? outcome.error : typeof error?.message === 'string' ? error.message : '';
  let reason = cause ? 'native_code' : 'unclassified';
  if (!cause && nativeText.includes('cannot attest a custom script launcher without its native target')) reason = 'native_target_unavailable';
  else if (!cause && /No route-compatible authentication source|no compatible credential source/i.test(nativeText)) reason = 'auth_route_unavailable';
  else if (!cause && /^(completed|succeeded)$/i.test(nativeText.trim())) reason = 'terminal_status_mismatch';
  const summary = {kind:'schedule_diagnostic',stage:['launch','wait','response'].includes(stage)?stage:'unknown',reason};
  if(cause) summary.causeCode=cause;
  if(['ok','error','timeout','pending'].includes(outcome?.status))summary.nativeStatus=outcome.status;
  if(['end_turn','tool_calls','error','cancelled','aborted','restart','timeout'].includes(outcome?.stopReason))summary.stopReason=outcome.stopReason;
  if(outcome)summary.terminalReplyPresent=typeof outcome.terminalReply?.text==='string' && outcome.terminalReply.text.length>0;
  return JSON.stringify(summary);
}
