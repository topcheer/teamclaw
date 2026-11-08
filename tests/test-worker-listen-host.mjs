#!/usr/bin/env node
// Issue #27: the worker HTTP server used to `listen(config.port)` with no
// host argument, binding `::` (all interfaces, dual-stack) on every system.
// Unlike the controller (which resolves 127.0.0.1 on hosts / 0.0.0.0 in
// containers), the worker exposed its unauthenticated task-assignment and
// message-injection endpoints to the whole network, and its default port
// 9527 silently collided with the controller default on same-host setups.
//
// Contracts pinned here (issue fix directions):
// a. Bind resolution: default loopback on hosts, 0.0.0.0 in containers,
//    explicit `listenHost` config overrides both.
// b. listen() actually passes the host (two-arg listen + EADDRINUSE hint
//    naming the 9527 collision and the port/listenHost config keys).
// c. Config: `listenHost` parses as an optional trimmed string; empty,
//    absent, or non-string values resolve to undefined (default policy).
// d. Parse-time warning: mode=worker with port 9527 (explicit or defaulted)
//    warns about the same-host controller collision; controller mode and
//    other worker ports stay silent. A warning, never an error.
// e. Loopback default keeps same-host reachability: a booted worker service
//    answers GET /api/v1/health on 127.0.0.1 (the software-rd
//    controller<->worker path is unaffected).

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// Contain state side effects (workspace bootstrap, identity persistence).
const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-listen-host-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;

const workerMod = await import(
  path.join(projectRoot, "src", "dist", "src", "worker", "worker-service.js")
).catch(() => null);
assert.ok(workerMod, "worker-service module must be built (run npm --prefix src run build first)");
const typesMod = await import(path.join(projectRoot, "src", "dist", "src", "types.js"));

// ── Contract a: bind host resolution ────────────────────────────────────────
{
  const { resolveWorkerListenHost } = workerMod;
  assert.equal(typeof resolveWorkerListenHost, "function", "resolveWorkerListenHost must be exported for the bind policy");

  const hadKubeEnv = process.env.KUBERNETES_SERVICE_HOST;
  try {
    // Host machine (no container markers): loopback default.
    delete process.env.KUBERNETES_SERVICE_HOST;
    assert.equal(resolveWorkerListenHost({}), "127.0.0.1", "default bind must be loopback on hosts (was all-interfaces before #27)");
    assert.equal(resolveWorkerListenHost({ listenHost: "" }), "127.0.0.1", "empty listenHost keeps the loopback default");
    assert.equal(resolveWorkerListenHost({ listenHost: "   " }), "127.0.0.1", "whitespace listenHost keeps the loopback default");

    // Container (Kubernetes service env, same detection as the controller):
    // all interfaces so service networking / the controller can reach in.
    process.env.KUBERNETES_SERVICE_HOST = "10.96.0.1";
    assert.equal(resolveWorkerListenHost({}), "0.0.0.0", "containerized workers must bind 0.0.0.0");

    // Explicit override wins over both defaults (external-worker escape hatch).
    assert.equal(resolveWorkerListenHost({ listenHost: "192.168.1.50" }), "192.168.1.50", "explicit listenHost overrides the container default");
    assert.equal(resolveWorkerListenHost({ listenHost: " 10.1.2.3 " }), "10.1.2.3", "explicit listenHost is trimmed");
  } finally {
    if (hadKubeEnv === undefined) {
      delete process.env.KUBERNETES_SERVICE_HOST;
    } else {
      process.env.KUBERNETES_SERVICE_HOST = hadKubeEnv;
    }
  }
}

// ── Contract b: source anchors - the listen call carries the host ──────────
{
  const source = await fs.promises.readFile(
    path.join(projectRoot, "src", "src", "worker", "worker-service.ts"),
    "utf8",
  );
  assert.match(
    source,
    /server!\.listen\(config\.port,\s*listenHost,/,
    "worker server.listen must pass the resolved host (issue #27 root cause: listen(config.port) bound ::)",
  );
  assert.doesNotMatch(
    source,
    /server!\.listen\(config\.port,\s*\(\)/,
    "the host-less listen call must be gone",
  );
  assert.match(source, /EADDRINUSE/, "the startup error path must special-case EADDRINUSE");
  assert.match(source, /Port 9527 is also the controller default/, "the EADDRINUSE hint must name the 9527 controller/worker default collision");
  assert.match(source, /`port` and `listenHost` plugin config keys/, "the EADDRINUSE hint must point at the port/listenHost config keys");
  // Same container detection semantics as the controller's resolve step.
  assert.match(source, /\/\.dockerenv/, "container detection checks /.dockerenv like the controller");
  assert.match(source, /\/run\/\.containerenv/, "container detection checks /run/.containerenv like the controller");
  assert.match(source, /KUBERNETES_SERVICE_HOST/, "container detection checks KUBERNETES_SERVICE_HOST like the controller");
  // External-worker advisory: loopback bind + remote controller is called out.
  assert.match(
    source,
    /cannot reach this worker/,
    "a loopback bind against a remote controller URL must produce an actionable warning",
  );
}

// ── Contract c: listenHost config parsing ───────────────────────────────────
{
  const { parsePluginConfig } = typesMod;
  assert.equal(parsePluginConfig({ mode: "worker", listenHost: "0.0.0.0" }).listenHost, "0.0.0.0", "explicit listenHost parses through");
  assert.equal(parsePluginConfig({ mode: "worker", listenHost: " 0.0.0.0 " }).listenHost, "0.0.0.0", "listenHost is trimmed");
  assert.equal(parsePluginConfig({ mode: "worker" }).listenHost, undefined, "absent listenHost parses to undefined (default policy applies)");
  assert.equal(parsePluginConfig({ mode: "worker", listenHost: "" }).listenHost, undefined, "empty listenHost parses to undefined");
  assert.equal(parsePluginConfig({ mode: "worker", listenHost: "   " }).listenHost, undefined, "blank listenHost parses to undefined");
  assert.equal(parsePluginConfig({ mode: "worker", listenHost: 42 }).listenHost, undefined, "non-string listenHost parses to undefined");

  // The generated manifest schema carries the new field (manifest:sync ran).
  const manifest = JSON.parse(await fs.promises.readFile(path.join(projectRoot, "src", "openclaw.plugin.json"), "utf8"));
  const schemaProps = manifest.configSchema?.properties;
  assert.ok(schemaProps, "manifest must carry a config schema");
  assert.equal(schemaProps.listenHost?.type, "string", "listenHost must be declared in the generated plugin manifest schema");
}

// ── Contract d: parse-time 9527 collision warning ───────────────────────────
{
  const { parsePluginConfig } = typesMod;
  const captureWarn = (run) => {
    const captured = [];
    const original = console.warn;
    console.warn = (...args) => { captured.push(args.join(" ")); };
    try {
      run();
    } finally {
      console.warn = original;
    }
    return captured;
  };

  const explicitWorker = captureWarn(() => parsePluginConfig({ mode: "worker", port: 9527 }));
  assert.equal(explicitWorker.length, 1, "worker mode with explicit port 9527 must warn exactly once");
  assert.match(explicitWorker[0], /9527/, "the warning must mention the colliding port");
  assert.match(explicitWorker[0], /port/, "the warning must point at the port config key");

  const defaultedWorker = captureWarn(() => parsePluginConfig({ mode: "worker" }));
  assert.equal(defaultedWorker.length, 1, "worker mode with the defaulted 9527 must also warn (same-host EADDRINUSE is the confusing case)");

  const otherPortWorker = captureWarn(() => parsePluginConfig({ mode: "worker", port: 9600 }));
  assert.equal(otherPortWorker.length, 0, "worker mode on a non-9527 port must stay silent");

  const controller9527 = captureWarn(() => parsePluginConfig({ mode: "controller", port: 9527 }));
  assert.equal(controller9527.length, 0, "controller mode on 9527 must stay silent (it owns the default)");

  // A warning, never an error: the flagged config still parses.
  const parsed = parsePluginConfig({ mode: "worker", port: 9527 });
  assert.equal(parsed.port, 9527, "worker+9527 must keep parsing (external workers may legitimately use it)");
}

// ── Contract e: booted worker answers on loopback (same-host path intact) ──
{
  const freePort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  const logs = [];
  const logger = {
    info: () => {},
    warn: (msg) => { logs.push(String(msg)); },
    error: () => {},
    debug: () => {},
  };
  const service = workerMod.createWorkerService({
    config: typesMod.parsePluginConfig({
      mode: "worker",
      port: freePort,
      // Unreachable local controller: registration fails fast, the HTTP
      // server still boots with the loopback default we are verifying.
      controllerUrl: `http://127.0.0.1:1`,
    }),
    logger,
    onIdentityEstablished: () => {},
  });
  await service.start({});
  try {
    const res = await fetch(`http://127.0.0.1:${freePort}/api/v1/health`);
    assert.equal(res.status, 200, "worker health endpoint must answer on 127.0.0.1 under the loopback default");
    const body = await res.json();
    assert.ok(body && typeof body === "object", "health endpoint returns JSON");
    assert.ok(
      !logs.some((line) => /different host/.test(line)),
      "loopback bind against a loopback controller URL must NOT trigger the external-worker advisory",
    );
  } finally {
    await service.stop();
  }
}

fs.rmSync(stateDir, { recursive: true, force: true });

console.log("test-worker-listen-host: all assertions passed (issue #27 loopback default, container 0.0.0.0, listenHost override, 9527 warn, EADDRINUSE hint)");
