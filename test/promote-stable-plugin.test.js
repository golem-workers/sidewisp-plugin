import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../deploy/promote-stable-plugin.sh", import.meta.url).pathname;

async function setup(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-promotion-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const envDir = path.join(root, "env");
  await fs.mkdir(bin);
  await fs.mkdir(envDir);
  const backendEnv = path.join(root, "backend.env");
  await fs.writeFile(backendEnv, [
    "SIDEWISP_PLUGIN_STABLE_VERSION=0.2.16",
    "SIDEWISP_PLUGIN_STABLE_SPEC=git:github.com/golem-workers/sidewisp-plugin@v0.2.16",
    `SIDEWISP_PLUGIN_STABLE_SHA256=${"a".repeat(64)}`,
    "SIDEWISP_UPDATE_ROLLOUT_PERCENT=100",
    "UNCHANGED=value",
    "",
  ].join("\n"));
  await fs.writeFile(path.join(envDir, "api-stable-b.env"), "PORT=3104\n");
  await fs.writeFile(path.join(envDir, "api-stable-a.env"), "PORT=3101\n");
  const artifact = path.join(root, "artifact.tgz");
  await fs.writeFile(artifact, "verified release fixture");
  const sha = crypto.createHash("sha256").update("verified release fixture").digest("hex");
  const systemctlLog = path.join(root, "systemctl.log");
  const smokeLog = path.join(root, "smoke.log");

  await fs.writeFile(path.join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ $1 == --output ]]; then cp "$MOCK_ARTIFACT" "$2"; exit 0; fi
  shift
done
exit 1
`);
  await fs.writeFile(path.join(bin, "systemctl"), `#!/usr/bin/env bash
set -euo pipefail
if [[ $1 == is-active && $2 == --quiet ]]; then
  [[ $3 == sidewisp-api@stable-b.service || $3 == sidewisp-api@stable-a.service ]] && exit 0
  [[ $MOCK_SYSTEMCTL_MODE == both && $3 == sidewisp-backend ]] && exit 0
  exit 3
fi
if [[ $1 == list-units ]]; then
  printf '%s\n' 'sidewisp-api@stable-b.service loaded active running b' 'sidewisp-api@stable-a.service loaded active running a'
  exit 0
fi
if [[ $1 == restart ]]; then printf '%s\n' "$2" >> "$MOCK_SYSTEMCTL_LOG"; exit 0; fi
exit 2
`);
  const smoke = path.join(bin, "smoke");
  await fs.writeFile(smoke, "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$1\" >> \"$MOCK_SMOKE_LOG\"\n");
  await Promise.all(["curl", "systemctl", "smoke"].map((name) => fs.chmod(path.join(bin, name), 0o755)));

  return {
    root, backendEnv, envDir, sha, systemctlLog, smokeLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_ARTIFACT: artifact,
      MOCK_SYSTEMCTL_LOG: systemctlLog,
      MOCK_SMOKE_LOG: smokeLog,
      MOCK_SYSTEMCTL_MODE: mode,
      SIDEWISP_BACKEND_ENV_FILE: backendEnv,
      SIDEWISP_BACKEND_SMOKE_SCRIPT: smoke,
      SIDEWISP_HA_ENV_DIR: envDir,
    },
  };
}

test("stable promotion rolls active HA APIs without starting legacy service", async (t) => {
  const fixture = await setup(t, "ha");
  const result = spawnSync("bash", [script, "0.2.17", fixture.sha], { env: fixture.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await fs.readFile(fixture.backendEnv, "utf8"), /SIDEWISP_PLUGIN_STABLE_VERSION=0\.2\.17/);
  assert.deepEqual((await fs.readFile(fixture.systemctlLog, "utf8")).trim().split("\n"), [
    "sidewisp-api@stable-b.service",
    "sidewisp-api@stable-a.service",
  ]);
  assert.deepEqual((await fs.readFile(fixture.smokeLog, "utf8")).trim().split("\n"), [
    "http://127.0.0.1:3104",
    "http://127.0.0.1:3101",
  ]);
});

test("stable promotion fails before mutation when legacy and HA APIs conflict", async (t) => {
  const fixture = await setup(t, "both");
  const before = await fs.readFile(fixture.backendEnv, "utf8");
  const result = spawnSync("bash", [script, "0.2.17", fixture.sha], { env: fixture.env, encoding: "utf8" });
  assert.equal(result.status, 65);
  assert.match(result.stderr, /legacy and HA/);
  assert.equal(await fs.readFile(fixture.backendEnv, "utf8"), before);
});
