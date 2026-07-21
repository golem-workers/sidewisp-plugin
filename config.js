export function resolveConfig(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    enabled: input.enabled !== false,
    configured: typeof input.setupToken === "string" && input.setupToken.length > 0,
    endpoint:
      typeof input.endpoint === "string" && input.endpoint.length > 0
        ? input.endpoint
        : "https://api.sidewisp.com",
  };
}
