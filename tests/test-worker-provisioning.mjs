#!/usr/bin/env node
// Unit tests for buildProvisionedWorkerConfig per-backend branching.
// Regression guard for the 2026-11-03 incident (PR #82): unconditionally
// deleting agents.entries crashed process workers with exit 78
// ("agents.entries must contain at least one configured agent").

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// W1 of issue #226: buildProvisionedWorkerConfig moved VERBATIM from
// controller/worker-provisioning.ts into controller/provisioning-config.ts
// (the facade re-exports it, so both paths expose the same function).
const mod = await import(
  path.join(projectRoot, "src", "dist", "src", "controller", "provisioning-config.js")
).catch(() => null);
assert.ok(mod, "provisioning-config module must be built (run npm --prefix src run build first)");
const { buildProvisionedWorkerConfig } = mod;
assert.equal(typeof buildProvisionedWorkerConfig, "function", "buildProvisionedWorkerConfig must be exported for testing");

const spec = { role: "developer", controllerUrl: "http://127.0.0.1:9527", workerPort: 9600, gatewayPort: 9601 };
const ctrl = (workerProvisioningType) => ({ teamName: "t", workerProvisioningType, heartbeatIntervalMs: 1000, taskTimeoutMs: 1000, gitEnabled: false });

function baseConfig() {
  return {
    channels: { telegram: { token: "secret" } },
    gateway: { mode: "remote", remote: { url: "wss://upstream" }, port: 4000 },
    agents: {
      entries: { main: { model: "glm-main" }, teamclaw: { model: "glm-worker" } },
      defaults: {
        model: "",
        heartbeat: { agentId: "main" },
        systemAgent: { agentId: "main" },
      },
    },
    plugins: { enabled: false },
  };
}

// --- process backend: keep ONLY the teamclaw entry, remap dangling agentIds ---
{
  const base = baseConfig();
  const out = buildProvisionedWorkerConfig(base, ctrl("process"), spec);
  assert.deepEqual(Object.keys(out.agents.entries), ["teamclaw"], "process workers must keep exactly one entry (>=1 requirement)");
  assert.equal(out.agents.entries.teamclaw.model, "glm-worker", "teamclaw entry preserved");
  assert.equal(out.agents.defaults.heartbeat.agentId, "teamclaw", "dangling heartbeat.agentId remapped to surviving entry");
  assert.equal(out.agents.defaults.systemAgent.agentId, "teamclaw", "dangling systemAgent.agentId remapped");
  assert.equal(out.agents.defaults.model, "glm-worker", "entry model folded into unset defaults.model");
  assert.equal(out.gateway.bind, "loopback", "process workers bind loopback");
  assert.equal(out.channels, undefined, "worker config drops channels");
  assert.ok(base.channels && base.agents.entries.main, "base config must not be mutated (cloneJson isolation)");
  // Already-valid references are a no-op.
  const valid = baseConfig();
  valid.agents.defaults.heartbeat.agentId = "teamclaw";
  const out2 = buildProvisionedWorkerConfig(valid, ctrl("process"), spec);
  assert.equal(out2.agents.defaults.heartbeat.agentId, "teamclaw", "valid agentId untouched");
}

// --- container backends: entries map removed (older runtimes reject keyed schema) ---
for (const backend of ["docker", "kubernetes"]) {
  const out = buildProvisionedWorkerConfig(baseConfig(), ctrl(backend), spec);
  assert.equal(out.agents.entries, undefined, `${backend}: entries must be deleted (legacy schema)`);
  assert.equal(out.agents.defaults.model, "glm-worker", `${backend}: entry model folded into defaults.model`);
  assert.equal(out.gateway.bind, "lan", `${backend}: workers bind all interfaces`);
}

// --- edge: host config has NO teamclaw entry (process) -> fall back to empty entry ---
{
  const base = baseConfig();
  delete base.agents.entries.teamclaw;
  const out = buildProvisionedWorkerConfig(base, ctrl("process"), spec);
  assert.deepEqual(out.agents.entries, { teamclaw: {} }, "empty teamclaw entry created when host lacks one (>=1 guarantee)");
}

// --- edge: defaults.model already set -> entry model must NOT override it ---
for (const backend of ["process", "docker"]) {
  const base = baseConfig();
  base.agents.defaults.model = "keep-me";
  const out = buildProvisionedWorkerConfig(base, ctrl(backend), spec);
  assert.equal(out.agents.defaults.model, "keep-me", `${backend}: preset defaults.model is not overwritten`);
}

// --- worker plugin config hardening: workers never provision sub-workers ---
{
  const out = buildProvisionedWorkerConfig(baseConfig(), ctrl("process"), spec);
  const tc = out.plugins.entries.teamclaw.config;
  assert.equal(out.plugins.enabled, true);
  assert.equal(tc.mode, "worker");
  assert.equal(tc.workerProvisioningType, "none");
  assert.equal(tc.role, "developer");
}

console.log("test-worker-provisioning: all assertions passed");
