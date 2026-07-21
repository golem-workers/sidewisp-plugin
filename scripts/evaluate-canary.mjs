#!/usr/bin/env node
import fs from "node:fs";
import { evaluateCanary } from "../src/release/canary.js";

const file = process.argv[2];
if (!file) throw new Error("usage: evaluate-canary.mjs <report.json>");
const result = evaluateCanary(JSON.parse(fs.readFileSync(file, "utf8")));
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
