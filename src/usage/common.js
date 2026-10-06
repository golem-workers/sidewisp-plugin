import crypto from "node:crypto";

export const USAGE_SCHEMA = "sidewisp.usage-batch.v1";
export const USAGE_PARSER_VERSION = "sidewisp.usage.v1";

export function safeId(parts) {
  return `usage:${crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

export function safeText(value, fallback = "unknown", max = 128) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/.test(text) ? text.slice(0, max) : fallback;
}

export function nonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

export function micros(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1_000_000) : null;
}

export function epochMs(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number < 10_000_000_000 ? number * 1000 : number);
}

export function usageCost({ actual, estimated, status, source, pricingVersion,
  billingMode = "unknown" } = {}) {
  const actualMicros = micros(actual);
  const estimatedMicros = micros(estimated);
  if (status === "actual" && actualMicros !== null) return { status: "actual", actualMicros,
    currency: "USD", billingMode, ...(source ? { source: safeText(source) } : {}),
    ...(pricingVersion ? { pricingVersion: safeText(pricingVersion) } : {}) };
  if (estimatedMicros !== null) return { status: "estimated", estimatedMicros,
    currency: "USD", billingMode, ...(source ? { source: safeText(source) } : {}),
    ...(pricingVersion ? { pricingVersion: safeText(pricingVersion) } : {}) };
  return { status: "unknown", currency: "USD", billingMode };
}
