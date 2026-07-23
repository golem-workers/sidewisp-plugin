#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { validUpdateDirective } from "../src/update/directive.js";

const directive = JSON.parse(process.argv[2] ?? "null");
if (!validUpdateDirective(directive)
  || !/^[a-f0-9]{64}$/.test(directive?.sha256 ?? "")
  || !directive?.stateFile || !directive?.collectorStatusFile || !directive?.installRoot
  || !["systemd-user", "launch-agent"].includes(directive?.serviceManager)) process.exit(2);

const stateFile = path.resolve(directive.stateFile);
const collectorStatusFile = path.resolve(directive.collectorStatusFile);
const installRoot = path.resolve(directive.installRoot);
const releasesRoot = path.join(installRoot, "releases");
const currentLink = path.join(installRoot, "current");
mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });

const writeState = (state) => {
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({
    ...state, runtime: "hermes", targetVersion: directive.targetVersion, updatedAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  renameSync(temp, stateFile);
};
const run = (command, args) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const restart = () => {
  if (directive.serviceManager === "systemd-user") {
    run("systemctl", ["--user", "restart", "sidewisp-hermes.service"]);
  } else {
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.sidewisp.hermes-collector`]);
  }
};
const serviceHealthy = () => {
  if (directive.serviceManager === "systemd-user") {
    run("systemctl", ["--user", "is-active", "--quiet", "sidewisp-hermes.service"]);
  } else {
    run("launchctl", ["print", `gui/${process.getuid()}/com.sidewisp.hermes-collector`]);
  }
};
const waitForCollector = async (startedAt) => {
  for (let attempt = 0; attempt < 36; attempt += 1) {
    try {
      serviceHealthy();
      const status = JSON.parse(readFileSync(collectorStatusFile, "utf8"));
      if (status.version === directive.targetVersion && status.status === "healthy"
        && Date.parse(status.heartbeatAt) >= startedAt) return;
    } catch { /* collector is still starting */ }
    await sleep(5_000);
  }
  throw new Error("target Hermes collector version did not become healthy");
};

writeState({ status: "scheduled" });
const delayMs = process.env.NODE_ENV === "test"
  ? Math.max(0, Number(process.env.SIDEWISP_TEST_UPDATE_DELAY_MS ?? 0))
  : directive.restartDelaySeconds * 1000;
await sleep(delayMs);

const workDir = path.join(os.tmpdir(), `sidewisp-hermes-update-${process.pid}`);
let previousTarget = null;
let targetRelease = null;
let phase = "DOWNLOAD";
try {
  writeState({ status: "downloading" });
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const tag = directive.targetSpec.slice(directive.targetSpec.lastIndexOf("@") + 1);
  const npmSource = `git+https://github.com/golem-workers/sidewisp-plugin.git#${tag}`;
  const tarball = run("npm", ["pack", npmSource, "--pack-destination", workDir]).trim().split(/\r?\n/).at(-1);
  if (!tarball || path.basename(tarball) !== tarball) throw new Error("invalid npm pack result");
  const tarballPath = path.join(workDir, tarball);
  const actualSha256 = crypto.createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  if (actualSha256 !== directive.sha256) throw new Error("downloaded package checksum mismatch");
  const unpacked = path.join(workDir, "package");
  mkdirSync(unpacked, { recursive: true, mode: 0o700 });
  run("tar", ["-xzf", tarballPath, "-C", unpacked, "--strip-components=1"]);
  const packageJson = JSON.parse(readFileSync(path.join(unpacked, "package.json"), "utf8"));
  if (packageJson.name !== "@sidewisp/plugin" || packageJson.version !== directive.targetVersion) {
    throw new Error("downloaded package identity or version mismatch");
  }
  for (const required of ["scripts/hermes-canary-daemon.mjs", "scripts/hermes-update-helper.mjs", "src/update/hermes-scheduler.js"]) {
    if (!existsSync(path.join(unpacked, required))) throw new Error(`release missing ${required}`);
  }

  targetRelease = path.join(releasesRoot, `v${directive.targetVersion}`);
  rmSync(targetRelease, { recursive: true, force: true });
  renameSync(unpacked, targetRelease);
  previousTarget = lstatSync(currentLink).isSymbolicLink() ? readlinkSync(currentLink) : null;
  if (!previousTarget) throw new Error("current Hermes release is not a symlink");

  phase = "SWITCH";
  writeState({ status: "switching" });
  const nextLink = `${currentLink}.${process.pid}.next`;
  symlinkSync(targetRelease, nextLink);
  renameSync(nextLink, currentLink);
  const startedAt = Date.now();
  phase = "RESTART";
  writeState({ status: "restarting" });
  restart();
  phase = "HEALTHCHECK";
  await waitForCollector(startedAt);
  writeState({ status: "completed" });
} catch {
  const errorCode = `UPDATE_${phase}_FAILED`;
  writeState({ status: "rolling_back", errorCode });
  try {
    if (previousTarget) {
      const rollbackLink = `${currentLink}.${process.pid}.rollback`;
      symlinkSync(previousTarget, rollbackLink);
      renameSync(rollbackLink, currentLink);
      restart();
      serviceHealthy();
    }
    writeState({ status: "rolled_back", errorCode });
  } catch {
    writeState({ status: "failed", errorCode: "ROLLBACK_FAILED", rollbackFrom: errorCode });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
  if (targetRelease && previousTarget && existsSync(targetRelease)) {
    try {
      if (readlinkSync(currentLink) !== targetRelease) rmSync(targetRelease, { recursive: true, force: true });
    } catch { /* preserve release for operator recovery */ }
  }
}
