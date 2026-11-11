#!/usr/bin/env node
// #255 P1-7: desktop main-process llm:list-models must gate the renderer-
// supplied endpoint (https anywhere, http only on loopback) before it is
// fetched with the user's API key.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mainPath = path.resolve(here, "../main.mjs");
const src = fs.readFileSync(mainPath, "utf8");

// Syntax gate (the same check the smoke suite runs on entrypoints).
execFileSync(process.execPath, ["--check", mainPath]);

// Wiring pins.
assert.ok(
  /function assertAllowedModelEndpoint\(raw\)\s*\{/.test(src),
  "main.mjs must define assertAllowedModelEndpoint",
);
assert.ok(
  /try \{ assertAllowedModelEndpoint\(endpoint\); \} catch \(e\) \{ return \{ error: e\.message \}; \}/.test(src),
  "fetchProviderModels must run the endpoint through the gate before fetching",
);
assert.ok(
  src.indexOf("function assertAllowedModelEndpoint") < src.indexOf("async function fetchProviderModels"),
  "the gate lives next to the model fetcher (single edit surface)",
);

// Functional check: extract the gate function and exercise its branches.
const fnSrc = src.match(/function assertAllowedModelEndpoint\(raw\)\s*\{[\s\S]*?\n\}/)[0];
const assertAllowedModelEndpoint = new Function(`${fnSrc.replace(/function assertAllowedModelEndpoint\(raw\)/, "return function(raw)")}`)();
const cases = [
  ["", true], // empty -> built-in https default
  ["https://api.example.com/v1", true],
  ["http://127.0.0.1:11434/v1", true], // local model gateway
  ["http://localhost:1234/v1", true],
  ["http://[::1]:8080/v1", true],
  ["http://192.168.1.5:8080/v1", false], // LAN http -> rejected
  ["http://api.example.com/v1", false], // remote http -> rejected
  ["ftp://api.example.com/v1", false],
  ["not a url", false],
];
for (const [input, shouldPass] of cases) {
  let passed = true;
  try { assertAllowedModelEndpoint(input); } catch { passed = false; }
  assert.equal(passed, shouldPass, `endpoint ${JSON.stringify(input)} expected ${shouldPass ? "pass" : "reject"}`);
}

console.log("test-llm-endpoint-gate: ok (main-process model endpoint gating wired + branch coverage)");
