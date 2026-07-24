#!/usr/bin/env node
import {
  installRuntimeHooks,
  removeRuntimeHooks,
} from "../src/adapters/command-hook/install.js";

const action = process.argv[2];
const runtimeKind = process.argv[3];
const settingsFile = process.argv[4];

if (action === "install") {
  const result = await installRuntimeHooks({
    runtimeKind,
    settingsFile,
    installRoot: process.argv[5],
    stateDir: process.argv[6],
    endpoint: process.argv[7],
    runtimeVersion: process.argv[8],
    adapterVersion: process.argv[9],
    nodePath: process.argv[10],
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} else if (action === "remove") {
  const result = await removeRuntimeHooks({ runtimeKind, settingsFile });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} else {
  throw new TypeError("action must be install or remove");
}
