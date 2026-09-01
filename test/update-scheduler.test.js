import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { isNewerVersion, validUpdateDirective } from "../src/update/directive.js";
import { createUpdateScheduler } from "../src/update/scheduler.js";
import { createHermesUpdateScheduler } from "../src/update/hermes-scheduler.js";

const directive = {
  schema: "sidewisp.plugin-update.v1",
  targetVersion: "0.1.15",
  targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.1.15",
  sha256: "a".repeat(64),
  restartDelaySeconds: 30,
};

test("update directives accept immutable SemVer releases only", () => {
  assert.equal(validUpdateDirective(directive), true);
  assert.equal(validUpdateDirective({ ...directive, targetSpec: "git:github.com/golem-workers/sidewisp-plugin@main" }), false);
  assert.equal(validUpdateDirective({ ...directive, targetSpec: "git:github.com/attacker/plugin@v0.1.15" }), false);
  assert.equal(validUpdateDirective({ ...directive, targetVersion: "0.1.16" }), false);
  assert.equal(validUpdateDirective({ ...directive, targetVersion: "01.1.15", targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v01.1.15" }), false);
  assert.equal(validUpdateDirective({ ...directive, targetVersion: "0.1.15-rc.01", targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.1.15-rc.01" }), false);
  assert.equal(validUpdateDirective({ ...directive, targetVersion: "0.1.15-rc..1", targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.1.15-rc..1" }), false);
  assert.equal(validUpdateDirective({ ...directive, restartDelaySeconds: 0 }), false);
});

test("version ordering follows SemVer and rejects downgrades", () => {
  assert.equal(isNewerVersion("0.2.17", "0.2.18"), false);
  assert.equal(isNewerVersion("0.2.18", "0.2.18"), false);
  assert.equal(isNewerVersion("0.2.19", "0.2.18"), true);
  assert.equal(isNewerVersion("0.2.18", "0.2.18-rc.1"), true);
  assert.equal(isNewerVersion("0.2.18-rc.2", "0.2.18-rc.10"), false);
  assert.equal(isNewerVersion("0.2.18-rc.10", "0.2.18-rc.2"), true);
});

test("OpenClaw scheduler ignores a stable-channel downgrade", () => {
  const calls = [];
  const scheduler = createUpdateScheduler({
    stateDir: "/tmp/sidewisp-state",
    currentVersion: "0.2.18",
    logger: { info() {} },
    spawnImpl(...args) {
      calls.push(args);
      return { unref() {} };
    },
  });
  assert.equal(scheduler.schedule({
    ...directive,
    targetVersion: "0.2.17",
    targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.2.17",
  }), false);
  assert.equal(scheduler.schedule({
    ...directive,
    targetVersion: "0.2.19",
    targetSpec: "git:github.com/golem-workers/sidewisp-plugin@v0.2.19",
  }), true);
  assert.equal(calls.length, 1);
});

test("Hermes scheduler launches one detached helper with bounded non-secret state", () => {
  const calls = [];
  const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const scheduler = createHermesUpdateScheduler({
    stateDir: "/tmp/sidewisp-state",
    installRoot: "/tmp/sidewisp-install",
    currentVersion: "0.1.13",
    serviceManager: "systemd-user",
    logger: { info() {} },
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  });
  assert.equal(scheduler.schedule(directive), true);
  assert.equal(scheduler.schedule(directive), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(path.basename(calls[0].args[0]), "hermes-update-helper.mjs");
  const payload = JSON.parse(calls[0].args[1]);
  assert.equal(payload.installRoot, "/tmp/sidewisp-install");
  assert.equal(payload.serviceManager, "systemd-user");
  assert.equal(payload.targetVersion, "0.1.15");
  assert.equal(payload.sha256, "a".repeat(64));
  assert.equal(Object.keys(calls[0].options.env).includes("SIDEWISP_SETUP_TOKEN"), false);
  assert.equal(child.unrefCalled, true);
});
