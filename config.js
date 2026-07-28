export function resolveConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    enabled: input.enabled !== false,
    configured: typeof input.setupToken === "string" && input.setupToken.length > 0,
    endpoint:
      typeof input.endpoint === "string" && input.endpoint.length > 0
        ? input.endpoint
        : "https://api.sidewisp.com",
    diagnosticsIntervalMs:
      Number.isSafeInteger(input.diagnosticsIntervalMs)
      && input.diagnosticsIntervalMs >= 60_000
      && input.diagnosticsIntervalMs <= 86_400_000
        ? input.diagnosticsIntervalMs
        : 15 * 60_000,
    diagnosticsMaxRefreshMs:
      Number.isSafeInteger(input.diagnosticsMaxRefreshMs)
      && input.diagnosticsMaxRefreshMs >= 60_000
      && input.diagnosticsMaxRefreshMs <= 86_400_000
        ? input.diagnosticsMaxRefreshMs
        : 60 * 60_000,
  };
}

export function readSetupToken(value) {
  const token = value && typeof value === "object" ? value.setupToken : undefined;
  return typeof token === "string" && token.startsWith("sw_setup_") ? token : null;
}
