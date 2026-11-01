#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { planFleetRollout } from '../src/release/fleet-rollout.js';

// Reviewable, read-only planning interface. This command does not publish,
// restart a service, or turn a plan into a completed installation.
if (process.argv.length !== 3) {
  console.error('usage: node scripts/plan-fleet-rollout.mjs <input.json>');
  process.exit(2);
}
try {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  console.log(JSON.stringify(planFleetRollout(input), null, 2));
} catch (error) {
  console.error(error instanceof SyntaxError ? 'INVALID_JSON' : error.message);
  process.exit(1);
}
