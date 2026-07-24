import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url)));
const license = fs.readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const plugin = fs.readFileSync(new URL("../src/adapters/openclaw/plugin.js", import.meta.url), "utf8");
const hermesInstaller = fs.readFileSync(new URL("../scripts/install-hermes.sh", import.meta.url), "utf8");
const hermesEnrollment = fs.readFileSync(new URL("../scripts/enroll-hermes.mjs", import.meta.url), "utf8");
const commandInstaller = fs.readFileSync(new URL("../scripts/install-command-runtime.sh", import.meta.url), "utf8");
const commandEnrollment = fs.readFileSync(new URL("../scripts/enroll-command-runtime.mjs", import.meta.url), "utf8");

test("public package declares AGPL-3.0-only consistently", () => {
  assert.equal(packageJson.license, "AGPL-3.0-only");
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.match(readme, /OSI-approved open-source license/);
  assert.doesNotMatch(readme, /PolyForm|Noncommercial/);
  assert.doesNotMatch(readme, /## License\s+MIT/);
});

test("runtime and package versions match", () => {
  const version = plugin.match(/const VERSION = "([^"]+)"/)?.[1];
  assert.equal(version, packageJson.version);
});

test("public installers default to the production endpoint", () => {
  for (const source of [hermesInstaller, hermesEnrollment, commandInstaller, commandEnrollment]) {
    assert.match(source, /https:\/\/api\.sidewisp\.com/);
    assert.doesNotMatch(source, /staging-api\.sidewisp\.com/);
  }
});

test("release archive includes public usage and policy documents", () => {
  for (const entry of [
    "docs",
    "README.md",
    "LICENSE",
    "LICENSING.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "INSTALLATION_PERMISSIONS.md",
    "E2E_AND_CANARY.md",
  ]) {
    assert.ok(packageJson.files.includes(entry), `${entry} missing from package files`);
  }
});
