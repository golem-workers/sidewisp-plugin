#!/usr/bin/env node
import path from "node:path";

import { createEnrollmentManager, createFileCredentialStore } from "../src/auth/credentials.js";
import { importHookInbox } from "../src/adapters/command-hook/bridge.js";
import { loadRuntimeHookConfig } from "../src/adapters/command-hook/config.js";
import { openSpool, SpoolError } from "../src/delivery/spool.js";
import { createUploader } from "../src/delivery/uploader.js";

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
  let spool;
  try {
    spool = await openSpool({ file: path.join(stateDir, "sidewisp", "spool.sqlite") });
  } catch (error) {
    if (error instanceof SpoolError && error.code === "locked") return;
    throw error;
  }
  try {
    const uploader = createUploader({
      spool,
      endpoint: config.endpoint,
      credentialProvider: { current: async () => credential },
      timeoutMs: 2_000,
    });
    // Hooks may land while this worker owns the single-writer spool lock.
    // Rescan briefly so a concurrent final hook is not stranded until the
    // next runtime event starts another drain worker.
    for (let pass = 0; pass < 3; pass += 1) {
      const imported = await importHookInbox({ runtimeKind, stateDir, spool });
      if (pass > 0 && imported.imported === 0) break;
      await uploader.drain({ maxAttempts: 1 });
      if (pass < 2) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await spool.close();
  }
}

await main().catch(() => {});
