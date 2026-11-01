const COMMAND = /^\/sidewisp_connect(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,2048})\s*$/;
const SCHEMA = "sidewisp.agent-enrollment.v1";
const SETUP_TOKEN = /^sw_setup_[A-Za-z0-9_-]{43}$/;
const INSTALLATION_ID = /^sw_ins_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const KEYS = Object.freeze([
  "apiUrl",
  "expiresAtMs",
  "installationId",
  "runtime",
  "schema",
  "setupToken",
]);

function invalid() {
  throw new TypeError("invalid or expired Sidewisp enrollment handoff");
}

export function parseTelegramEnrollmentMessage(message, expectedEndpoint, nowMs = Date.now()) {
  const match = typeof message === "string" ? COMMAND.exec(message) : null;
  if (!match) return null;
  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded || bytes.length > 1024) invalid();
  let input;
  try { input = JSON.parse(bytes.toString("utf8")); }
  catch { invalid(); }
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
  const keys = Object.keys(input).sort();
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) invalid();
  if (input.schema !== SCHEMA || input.runtime !== "openclaw") invalid();
  if (!INSTALLATION_ID.test(input.installationId) || !SETUP_TOKEN.test(input.setupToken)) invalid();
  if (input.apiUrl !== expectedEndpoint) invalid();
  if (
    !Number.isSafeInteger(input.expiresAtMs)
    || input.expiresAtMs <= nowMs
    || input.expiresAtMs > nowMs + MAX_TTL_MS + CLOCK_SKEW_MS
  ) invalid();
  return Object.freeze({
    schema: SCHEMA,
    installationId: input.installationId,
    runtime: "openclaw",
    apiUrl: input.apiUrl,
    setupToken: input.setupToken,
    expiresAtMs: input.expiresAtMs,
  });
}

export function createTelegramEnrollmentHook({
  auth,
  deleteSourceMessage,
  expectedEndpoint,
  isAuthorizedSender,
  logger,
  now = Date.now,
}) {
  let pending = Promise.resolve();
  return async (event, ctx) => {
    const message = event?.body ?? event?.content;
    if (event?.channel !== "telegram" || typeof message !== "string" || !COMMAND.test(message)) return;
    const run = pending.then(async () => {
      let handoff;
      try {
        if (!isAuthorizedSender(event.senderId)) throw new Error("sender denied");
        if (!ctx?.conversationId || !event.messageId) throw new Error("source identity unavailable");
        await deleteSourceMessage({
          accountId: ctx.accountId,
          conversationId: ctx.conversationId,
          messageId: event.messageId,
        });
        handoff = parseTelegramEnrollmentMessage(message, expectedEndpoint, now());
        await auth.load();
        if (auth.canSend() && auth.status().installationId === handoff.installationId) {
          return { handled: true, text: "Sidewisp is already connected on this agent." };
        }
        const result = await auth.enroll(handoff.setupToken);
        return { handled: true, text: `Sidewisp connected. Installation: ${result.installationId}` };
      } catch {
        logger.warn("Sidewisp Telegram enrollment failed (credential redacted)");
        return {
          handled: true,
          text: "Sidewisp connection failed. The source message could not be removed or the handoff is invalid, expired, or already used.",
        };
      } finally {
        handoff = null;
      }
    });
    pending = run.then(() => undefined, () => undefined);
    return run;
  };
}
