#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createEnrollmentManager, createFileCredentialStore } from "../src/auth/credentials.js";
import { readHookPayload, stageRuntimeHook } from "../src/adapters/command-hook/bridge.js";
import { loadRuntimeHookConfig } from "../src/adapters/command-hook/config.js";

async function main() {
  const runtimeKind = process.argv[2];
  const stateDir = path.resolve(process.argv[3] || ".");
  const config = await loadRuntimeHookConfig(stateDir, runtimeKind);
  const auth = createEnrollmentManager({
    endpoint: config.endpoint,
    store: createFileCredentialStore({ stateDir }),
  });
  await auth.load();
  const credential = auth.credential();
  if (!credential) return;
  const payload = await readHookPayload(process.stdin);
  const result = await stageRuntimeHook({
    runtimeKind,
    payload,
    stateDir,
    installationId: credential.installationId,
    runtimeVersion: config.runtimeVersion,
    adapterVersion: config.adapterVersion,
  });
  if (result.staged === 0) return;
  const worker = spawn(process.execPath, [
    fileURLToPath(new URL("./runtime-hook-drain.mjs", import.meta.url)),
    runtimeKind,
    stateDir,
  ], {
    detached: true,
    stdio: "ignore",
  });
  worker.unref();
}

await main().catch(() => {});
