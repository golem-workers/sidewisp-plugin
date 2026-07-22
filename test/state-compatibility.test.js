import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createFileCredentialStore } from "../src/auth/credentials.js";
import { openSpool } from "../src/delivery/spool.js";

const credential = { installationId: "sw_ins_fixture001", secret: `sw_secret_${"r".repeat(32)}`, status: "active" };
const event = { eventId: "sw_evt_pending_rollback", type: "turn.failed" };

test("upgrade and rollback preserve credentials, cursor, and pending events", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const credentialStore = createFileCredentialStore({ stateDir: root });
  await credentialStore.write(credential);
  const file = path.join(root, "sidewisp", "spool.sqlite");
  let spool = await openSpool({ file });
  spool.enqueueSourceBatch("fixture", "cursor-v1", [event]);
  await spool.close();

  spool = await openSpool({ file });
  assert.deepEqual(await credentialStore.read(), credential);
  assert.equal(spool.cursor("fixture"), "cursor-v1");
  assert.deepEqual(spool.pending(), [{ eventId: event.eventId, event }]);
  await spool.close();
});

test("newer spool schema fails visibly and is never quarantined as corruption", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sidewisp-schema-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "spool.sqlite");
  const spool = await openSpool({ file });
  await spool.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE metadata SET value='999' WHERE key='schema_version'").run();
  db.close();
  await assert.rejects(openSpool({ file }), (error) => error?.code === "unsupported-schema");
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes(".corrupt-")), []);
});
