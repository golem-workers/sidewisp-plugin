// Read only allowlisted user-facing question/answer fields. Never logs, commands,
// arbitrary tool output, reasoning, attachments, or a neighbouring work item.
import { readMessagePreview } from "./message-preview.js";
export function userWaitPreview(data, operation, type) {
  const details = { operation };
  return readMessagePreview(() => {
    if (operation === "user_approval") {
      if (type === "tool.started") return data.title;
      return ({ approved: "Подтверждение пользователя: одобрено.", allowed: "Подтверждение пользователя: одобрено.",
        denied: "Подтверждение пользователя: отклонено." })[data.status];
    }
    if (operation !== "request_user_input") return undefined;
    if (type === "tool.started") {
      const questions = data.args?.questions;
      if (!Array.isArray(questions) || questions.length < 1 || questions.length > 10) return undefined;
      const text = questions.map(q => q?.question ?? q?.title);
      if (text.some(v => typeof v !== "string" || v.length > 16_384)) return undefined;
      return text.join(" ");
    }
    // Structured response schema only; do not read result.content or result.text.
    const answers = data.result?.answers ?? data.result?.details?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return undefined;
    const values = Object.values(answers);
    if (!values.length || values.length > 10) return undefined;
    const text = [];
    for (const value of values) {
      if (!Array.isArray(value?.answers) || !value.answers.length || value.answers.length > 10) return undefined;
      for (const answer of value.answers) {
        if (typeof answer !== "string" || answer.length > 16_384) return undefined;
        text.push(answer);
      }
    }
    return text.join(" ");
  }, type, details);
}
export function eventReasonPreview(type, input) {
  // Fixed labels of confirmed metadata, explicitly not an assistant answer.
  // No exception/log text is read. Unknown reasons stay absent.
  if (type === "turn.cancelled" && input.outcome === "cancelled") return "Причина события: выполнение остановлено.";
  if (type === "turn.timeout" && input.outcome === "timeout") return "Причина события: превышено время выполнения.";
  if (type === "turn.failed" && input.outcome === "failure") return "Причина события: ошибка выполнения.";
  return undefined;
}
