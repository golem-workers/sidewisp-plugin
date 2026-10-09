// This is the only free-text telemetry exception. Keep plugin/API policies in sync.
export const MESSAGE_PREVIEW_MAX = 160;
const PREVIEW_TYPES = new Set(["turn.progress", "turn.completed", "message.delivered"]);
const SENSITIVE = /(?:bearer|authorization|api[\s_-]*key|access[\s_-]*key|private[\s_-]*key|password|passwd|secret|credential|token|парол|секрет|токен|ключ\s*(?:api|доступ)|персональн|конфиденциальн|private|confidential)|(?:[a-z][a-z0-9+.-]{0,32}:\/\/)|(?:[\w.+-]{1,64}@[\w.-]{1,253}\.[a-z]{2,63})|(?:\b(?:sk|ghp|github_pat|xox[baprs])[-_][a-z0-9_-]+)|(?:\beyJ[a-z0-9_-]+\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)?)|(?:[a-z0-9_+\/=-]{24,})|(?:\d[\s().+-]*){7,}|(?:^|\s)(?:[~\/]\S+|[a-z]:[\\/]\S+)|(?:```|-----BEGIN)/iu;
const UNSAFE_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function sanitizeMessagePreview(value, type) {
  try {
    if (!PREVIEW_TYPES.has(type) || typeof value !== "string" || value.length > 16_384) return undefined;
    // Remove invisible formatting before scanning so it cannot split a secret marker.
    const text = value.normalize("NFC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
    // Scan the entire bounded message BEFORE truncation, including credentials past char 160.
    // Omit the whole preview instead of trying to redact arbitrary secret values.
    if (!text || UNSAFE_CONTROL.test(text) || SENSITIVE.test(text.normalize("NFKC"))) return undefined;
    if (text.length <= MESSAGE_PREVIEW_MAX) return text;
    let prefix = text.slice(0, MESSAGE_PREVIEW_MAX - 1);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    return prefix.trimEnd() + "…";
  } catch { return undefined; } // Optional text must never suppress a lifecycle event.
}

export function readMessagePreview(read, type) {
  try { return sanitizeMessagePreview(read(), type); } catch { return undefined; }
}
