// This is the only free-text telemetry exception. Keep plugin/API policies in sync.
export const MESSAGE_PREVIEW_MAX = 160;
const PREVIEW_TYPES = new Set(["turn.progress", "turn.completed", "message.delivered"]);
// Detect credential VALUES/structures, not words used to discuss credentials.
const SENSITIVE = /(?:\b(?:bearer)\s+[^\s,;]+)|(?:(?:authorization|api[\s_-]*key|access[\s_-]*(?:key|token)|refresh[\s_-]*token|private[\s_-]*key|password|passwd|secret|credential|token|пароль|секрет|токен|ключ\s*(?:api|доступа))\s*["'`]?\s*[:=]\s*["'`]?[^\s,;"'`]+)|(?:[?&](?:key|code|sig|signature|token|password|secret)=[^\s&#]+)|(?:[a-z][a-z0-9+.-]{0,32}:\/\/[^\s/]*:[^\s/@]+@)|(?:[\w.+-]{1,64}@[\w.-]{1,253}\.[a-z]{2,63})|(?:\b(?:sk|ghp|gho|ghu|ghs|ghr|github_pat|xox[baprs])[-_][a-z0-9_-]+)|(?:\b(?:AKIA|ASIA)[A-Z0-9]{16}\b)|(?:\bAIza[a-z0-9_-]{30,})|(?:\beyJ[a-z0-9_-]+\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)?)|(?:\+\d[\d\s().-]{8,}\d)|(?:\b(?:\d[ -]?){13,19}\b)|(?:```|-----BEGIN)/iu;

function hasOpaqueCredential(text) {
  // No length-only blacklist: cron names, paths, commits and event IDs are not keys.
  for (const match of text.matchAll(/(?<![\w/.-])[A-Za-z0-9_+\/=-]{24,}(?![\w/.-])/g)) {
    const value = match[0];
    if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) continue;
    const counts = new Map();
    for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) { const p = count / value.length; entropy -= p * Math.log2(p); }
    if (entropy >= 3.5) return true;
  }
  return false;
}
const UNSAFE_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export function sanitizeMessagePreview(value, type) {
  try {
    if (!PREVIEW_TYPES.has(type) || typeof value !== "string" || value.length > 16_384) return undefined;
    // Remove invisible formatting before scanning so it cannot split a secret marker.
    const text = value.normalize("NFC").replace(/\p{Cf}/gu, "").replace(/\s+/gu, " ").trim();
    // Scan the entire bounded message BEFORE truncation, including credentials past char 160.
    // Omit the whole preview instead of trying to redact arbitrary secret values.
    if (!text || UNSAFE_CONTROL.test(text) || (SENSITIVE.test(text.normalize("NFKC")) || hasOpaqueCredential(text.normalize("NFKC")))) return undefined;
    if (text.length <= MESSAGE_PREVIEW_MAX) return text;
    let prefix = text.slice(0, MESSAGE_PREVIEW_MAX - 1);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    return prefix.trimEnd() + "…";
  } catch { return undefined; } // Optional text must never suppress a lifecycle event.
}

export function readMessagePreview(read, type) {
  try { return sanitizeMessagePreview(read(), type); } catch { return undefined; }
}
