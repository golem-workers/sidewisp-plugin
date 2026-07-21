import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { evaluateCanary } from "../src/release/canary.js";

const fixture = () => JSON.parse(fs.readFileSync(new URL("fixtures/canary-report.json", import.meta.url)));

test("controlled canary satisfies every staged-rollout gate", () => {
  const result = evaluateCanary(fixture());
  assert.equal(result.pass, true);
  assert.deepEqual(result.rollout, [5, 25, 100]);
  assert.equal(result.metrics.falsePositiveRate, 0);
  assert.ok(result.metrics.p95VisibilityLatencySeconds <= 30);
});

test("rollout stops on false positives, privacy findings, or missing evidence", () => {
  const report = fixture();
  report.falsePositives = 2;
  report.forbiddenPayloadFindings = 1;
  report.evidence.rollback = false;
  const result = evaluateCanary(report);
  assert.equal(result.pass, false);
  assert.deepEqual(result.rollout, []);
  assert.deepEqual(result.stopCriteria, ["falsePositiveRate", "privacy", "evidence"]);
});
