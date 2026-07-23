import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Hermes helper atomically switches release and proves the new collector heartbeat", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidewisp-hermes-helper-"));
  try {
    const installRoot = path.join(root, "install");
    const releases = path.join(installRoot, "releases");
    const oldRelease = path.join(releases, "v0.1.13");
    const stateRoot = path.join(root, "state", "sidewisp");
    const bin = path.join(root, "bin");
    const pack = path.join(root, "pack");
    fs.mkdirSync(oldRelease, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    fs.mkdirSync(pack, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(oldRelease, "package.json"), JSON.stringify({ name: "@sidewisp/plugin", version: "0.1.13" }));
    fs.symlinkSync(oldRelease, path.join(installRoot, "current"));

    const tarballName = execFileSync("npm", ["pack", new URL("..", import.meta.url).pathname, "--pack-destination", pack], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim().split(/\r?\n/).at(-1);
    const tarball = path.join(pack, tarballName);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
    const collectorStatusFile = path.join(stateRoot, "collector-status.json");
    const stateFile = path.join(stateRoot, "update-status.json");

    fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh
set -eu
destination=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--pack-destination" ]; then destination="$2"; shift 2; else shift; fi
done
cp "$SIDEWISP_TEST_TARBALL" "$destination/$SIDEWISP_TEST_TARBALL_NAME"
printf '%s\\n' "$SIDEWISP_TEST_TARBALL_NAME"
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh
set -eu
case "$*" in
  *restart*)
    printf '{"status":"healthy","version":"0.1.17","heartbeatAt":"%s"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" > "$SIDEWISP_TEST_COLLECTOR_STATUS"
    ;;
esac
`, { mode: 0o700 });

    const directive = {
      schema: "sidewisp.plugin-update.v1",
      targetVersion: "0.1.17",
      targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.1.17",
      sha256,
      restartDelaySeconds: 30,
      stateFile,
      collectorStatusFile,
      installRoot,
      serviceManager: "systemd-user",
    };
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/hermes-update-helper.mjs", import.meta.url)), JSON.stringify(directive)], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        SIDEWISP_TEST_UPDATE_DELAY_MS: "0",
        SIDEWISP_TEST_TARBALL: tarball,
        SIDEWISP_TEST_TARBALL_NAME: tarballName,
        SIDEWISP_TEST_COLLECTOR_STATUS: collectorStatusFile,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const updateState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(updateState.status, "completed", JSON.stringify(updateState));
    assert.equal(JSON.parse(fs.readFileSync(path.join(installRoot, "current", "package.json"), "utf8")).version, "0.1.17");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
