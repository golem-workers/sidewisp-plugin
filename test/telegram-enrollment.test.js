import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramEnrollmentHook, parseTelegramEnrollmentMessage } from "../src/auth/telegram-enrollment.js";

const NOW = 1_800_000_000_000;
const ENDPOINT = "https://staging-api.sidewisp.com";
const TOKEN = `sw_setup_${"A".repeat(43)}`;
const HANDOFF = Object.freeze({
  schema: "sidewisp.agent-enrollment.v1",
  installationId: "sw_ins_12345678-1234-4123-8123-123456789abc",
  runtime: "openclaw",
  apiUrl: ENDPOINT,
  setupToken: TOKEN,
  expiresAtMs: NOW + 600_000,
});
const encoded = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const command = (value = HANDOFF) => `/sidewisp_connect ${encoded(value)}`;

test("parses only canonical current staging OpenClaw handoffs", () => {
  assert.deepEqual(parseTelegramEnrollmentMessage(command(), ENDPOINT, NOW), HANDOFF);
  assert.equal(parseTelegramEnrollmentMessage("ordinary message", ENDPOINT, NOW), null);
  for (const value of [
    { ...HANDOFF, runtime: "hermes" },
    { ...HANDOFF, expiresAtMs: NOW },
    { ...HANDOFF, unexpected: true },
    { ...HANDOFF, apiUrl: "https://api.sidewisp.com" },
  ]) assert.throws(() => parseTelegramEnrollmentMessage(command(value), ENDPOINT, NOW), /invalid or expired/);
});

test("deletes the source before exchange and returns no credential material", async () => {
  let active = false;
  let installationId = null;
  const calls = [];
  const logs = [];
  const hook = createTelegramEnrollmentHook({
    now: () => NOW,
    expectedEndpoint: ENDPOINT,
    logger: { warn: (message) => logs.push(message) },
    isAuthorizedSender: (senderId) => senderId === "8570687641",
    deleteSourceMessage: async (value) => calls.push(["delete", value]),
    auth: {
      load: async () => calls.push(["load"]),
      canSend: () => active,
      status: () => ({ state: active ? "active" : "unconfigured", installationId }),
      enroll: async (token) => {
        assert.equal(token, TOKEN);
        assert.equal(calls[0][0], "delete");
        active = true;
        installationId = HANDOFF.installationId;
        return { installationId: HANDOFF.installationId, status: "active" };
      },
    },
  });
  const result = await hook({
    body: command(), channel: "telegram", messageId: "42", senderId: "8570687641",
  }, { accountId: "default", conversationId: "-1001" });
  assert.deepEqual(calls, [
    ["delete", { accountId: "default", conversationId: "-1001", messageId: "42" }],
    ["load"],
  ]);
  assert.equal(result.handled, true);
  assert.match(result.text, /Sidewisp connected/);
  assert.equal(JSON.stringify({ result, logs, calls }).includes(TOKEN), false);
});

test("replaces an active credential when a fresh handoff targets a new installation", async () => {
  const oldInstallationId = "sw_ins_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let installationId = oldInstallationId;
  let exchanges = 0;
  const hook = createTelegramEnrollmentHook({
    now: () => NOW,
    expectedEndpoint: ENDPOINT,
    logger: { warn: () => {} },
    isAuthorizedSender: () => true,
    deleteSourceMessage: async () => {},
    auth: {
      load: async () => {},
      canSend: () => true,
      status: () => ({ state: "active", installationId }),
      enroll: async (token) => {
        assert.equal(token, TOKEN);
        exchanges += 1;
        installationId = HANDOFF.installationId;
        return { installationId, status: "active" };
      },
    },
  });

  const result = await hook({
    body: command(), channel: "telegram", messageId: "43", senderId: "8570687641",
  }, { accountId: "default", conversationId: "-1001" });

  assert.equal(exchanges, 1);
  assert.match(result.text, /Sidewisp connected/);
  assert.equal(installationId, HANDOFF.installationId);
});

test("keeps an active credential when the handoff targets the same installation", async () => {
  let exchanges = 0;
  const hook = createTelegramEnrollmentHook({
    now: () => NOW,
    expectedEndpoint: ENDPOINT,
    logger: { warn: () => {} },
    isAuthorizedSender: () => true,
    deleteSourceMessage: async () => {},
    auth: {
      load: async () => {},
      canSend: () => true,
      status: () => ({ state: "active", installationId: HANDOFF.installationId }),
      enroll: async () => { exchanges += 1; },
    },
  });

  const result = await hook({
    body: command(), channel: "telegram", messageId: "44", senderId: "8570687641",
  }, { accountId: "default", conversationId: "-1001" });

  assert.equal(exchanges, 0);
  assert.match(result.text, /already connected/);
});

test("fails closed before exchange when deletion or authorization fails", async () => {
  for (const failure of ["authorization", "deletion"]) {
    let enrollCalls = 0;
    const hook = createTelegramEnrollmentHook({
      now: () => NOW,
      expectedEndpoint: ENDPOINT,
      logger: { warn: () => {} },
      isAuthorizedSender: () => failure !== "authorization",
      deleteSourceMessage: async () => {
        if (failure === "deletion") throw new Error("denied");
      },
      auth: {
        load: async () => {},
        canSend: () => false,
        enroll: async () => { enrollCalls += 1; },
      },
    });
    const result = await hook({
      body: command(), channel: "telegram", messageId: "42", senderId: "8570687641",
    }, { accountId: "default", conversationId: "-1001" });
    assert.equal(result.handled, true);
    assert.equal(enrollCalls, 0);
    assert.equal(result.text.includes(TOKEN), false);
  }
});
