// #hot-config: GET/PATCH /api/v1/team/config hot-reload behavior tests.
// Covers: whitelist rejection, bounds clamping, in-memory live-apply on the
// shared deps.config object, min<=max invariant, k8s memory-only mode, and
// persistence success/failure paths (persist failure must not fail the patch).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import path from "node:path";

const mod = await import("../src/dist/src/controller/config-routes.js");
assert.equal(typeof mod.teamConfigGetRoute, "function");
assert.equal(typeof mod.teamConfigPatchRoute, "function");

// Minimal harness: a fake RouteContext around the real handlers.
function makeCtx(config, extra = {}) {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
    writeHead(code, headers) { this.statusCode = code; if (headers) Object.assign(this.headers, headers); },
    end(payload) { this.body = payload; },
  };
  return {
    req: Readable.from([Buffer.from(JSON.stringify(extra.body ?? {}))]),
    res,
    deps: {
      config,
      logger: { info() {}, warn() {} },
      wsServer: { events: [], broadcastUpdate(e) { this.events.push(e); } },
      workerProvisioningManager: { reconciles: [], async requestReconcile(r) { this.reconciles.push(r); } },
      ...extra.deps,
    },
  };
}
async function run(config, body) {
  const ctx = makeCtx(config, { body });
  await mod.teamConfigPatchRoute(ctx);
  const payload = JSON.parse(String(ctx.res.body));
  return { status: ctx.res.statusCode, payload, ctx };
}
const baseConfig = () => ({
  workerProvisioningType: "process",
  workerProvisioningDisabled: false,
  workerProvisioningMinPerRole: 0,
  workerProvisioningMaxPerRole: 1,
  workerProvisioningIdleTtlMs: 120000,
  port: 9527,
});

// 1) GET returns the snapshot + host-config persistence mode.
{
  const ctx = makeCtx(baseConfig());
  mod.teamConfigGetRoute(ctx);
  const out = JSON.parse(String(ctx.res.body));
  assert.equal(out.workerProvisioningMaxPerRole, 1);
  assert.equal(out.persistenceMode, "host-config");
}

// 2) Unknown field rejected.
{
  const r = await run(baseConfig(), { evilField: 1 });
  assert.equal(r.status, 400);
  assert.match(r.payload.error, /non-hot-reloadable/);
}

// 3) Bounds clamping + live in-memory apply + reconcile poke + WS broadcast.
{
  const cfg = baseConfig();
  // Redirect persistence at a scratch config so the real home config is untouched.
  const dir = mkdtempSync(path.join(tmpdir(), "tc-hotcfg-"));
  const cfgPath = path.join(dir, "openclaw.json");
  writeFileSync(cfgPath, JSON.stringify({ plugins: { entries: { teamclaw: { enabled: true, config: { teamName: "x" } } } } }));
  const saved = { ...process.env, OPENCLAW_CONFIG_PATH: cfgPath };
  process.env = saved;
  const r = await run(cfg, { workerProvisioningMaxPerRole: 999, workerProvisioningIdleTtlMs: 500 });
  process.env = saved; // keep during assertions too
  assert.equal(r.status, 200);
  assert.equal(r.payload.applied.workerProvisioningMaxPerRole, 50, "max clamped to 50");
  assert.equal(r.payload.applied.workerProvisioningIdleTtlMs, 1000, "ttl floored at 1000");
  assert.equal(cfg.workerProvisioningMaxPerRole, 50, "deps.config mutated in place");
  assert.equal(cfg.workerProvisioningIdleTtlMs, 1000);
  assert.equal(r.payload.persisted, true, "host-config write succeeded");
  assert.equal(r.ctx.deps.workerProvisioningManager.reconciles.length, 1, "reconcile poked");
  const ws = r.ctx.deps.wsServer.events[0];
  assert.equal(ws.type, "team:config_updated");
  // Persisted file carries the whitelisted field and preserves unrelated keys.
  const onDisk = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(onDisk.plugins.entries.teamclaw.config.workerProvisioningMaxPerRole, 50);
  assert.equal(onDisk.plugins.entries.teamclaw.config.teamName, "x", "unrelated plugin config preserved");
}

// 4) min<=max invariant: raising min above max lifts max.
{
  const cfg = baseConfig();
  cfg.workerProvisioningMaxPerRole = 4;
  const r = await run(cfg, { workerProvisioningMinPerRole: 8 });
  assert.equal(r.payload.applied.workerProvisioningMaxPerRole, 8);
  assert.equal(cfg.workerProvisioningMaxPerRole, 8);
}

// 5) k8s shape: memory-only, never touches disk.
{
  const cfg = baseConfig();
  cfg.workerProvisioningType = "kubernetes";
  const r = await run(cfg, { workerProvisioningMaxPerRole: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.payload.persistenceMode, "memory-only");
  assert.equal(r.payload.persisted, false);
  assert.match(r.payload.restartNote, /memory only/);
}

// 6) Persist failure degrades to applied-in-memory, not an error.
{
  const cfg = baseConfig();
  process.env = { ...process.env, OPENCLAW_CONFIG_PATH: path.join(tmpdir(), "definitely-missing-", String(Date.now()), "openclaw.json") };
  const r = await run(cfg, { workerProvisioningMaxPerRole: 6 });
  assert.equal(r.status, 200, "patch still 200 when disk write fails");
  assert.equal(cfg.workerProvisioningMaxPerRole, 6, "memory applied regardless");
  assert.equal(r.payload.persisted, false);
}

console.log("test-team-config-hotreload: all 6 sections passed");
