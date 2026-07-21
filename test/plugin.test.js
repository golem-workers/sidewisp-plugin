import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { readSetupToken, resolveConfig } from "../config.js";

test("manifest declares an on-startup Sidewisp plugin", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url)));
  assert.equal(manifest.id, "sidewisp");
  assert.equal(manifest.activation.onStartup, true);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.equal(manifest.uiHints.setupToken.sensitive, true);
});

test("configuration never exposes the setup token", () => {
  const config = resolveConfig({ setupToken: "sw_setup_secret", endpoint: "https://example.test" });
  assert.deepEqual(config, {
    enabled: true,
    configured: true,
    endpoint: "https://example.test",
  });
  assert.equal(JSON.stringify(config).includes("sw_setup_secret"), false);
  assert.equal(readSetupToken({ setupToken: "sw_setup_secret" }), "sw_setup_secret");
});

test("defaults to zero-configuration pending setup", () => {
  assert.deepEqual(resolveConfig(), {
    enabled: true,
    configured: false,
    endpoint: "https://api.sidewisp.com",
  });
});
