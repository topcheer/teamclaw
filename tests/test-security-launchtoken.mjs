#!/usr/bin/env node
// Issue #255 P0-1 + P1-4 (launchToken hardening): behavioral + source-pin
// tests against the real compiled modules (run `npm --prefix src run build`
// first).
//
// Covers:
//   1. CSPRNG generation: generateLaunchToken() is 64 lowercase hex chars
//      (randomBytes(32)) and never repeats across draws; generateId() keeps
//      its historical `<base36 ts>-<6 base36 chars>` shape. Source pins:
//      protocol.ts is Math.random-free, the provisioner mints tokens via
//      generateLaunchToken, and a whole-src walk shows Math.random survives
//      only in the two non-secret suffix generators (project slug / archive
//      file name) - no token or id generator still uses it.
//   2. /team/status redaction on a REAL controller HTTP server: with a
//      provisioning worker record whose launchToken is a unique sentinel,
//      the response JSON contains no launchToken KEY anywhere in the tree
//      and the raw body never contains the sentinel VALUE; the rest of the
//      worker metadata survives.
//   3. validateRegistration is constant-time (source pin on secretsEqual)
//      and behaviorally accepts OLD Math.random-era tokens from upgraded
//      TeamStates (equality semantics unchanged), while still rejecting
//      wrong/missing tokens.
//   4. TeamState file mode (P1-4): team-state.json is created 0600, a
//      pre-existing 0644 file from an older build is tightened to 0600 on
//      the next save, and worker-identity.json rides the same mode.
//      POSIX-only assertions (mode bits are meaningless on Windows).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));
const srcFile = (rel) => fs.readFileSync(path.join(projectRoot, "src", "src", rel), "utf8");

// --- env must be in place before the first dist import ---------------------
process.env.TEAMCLAW_EXTRA_PROFILES_DIR = path.join(scriptDir, "fixtures", "profiles");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-launchtoken-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-launchtoken-ws-"));

const logger = {
  infos: [], warns: [],
  info(e) { this.infos.push(e); },
  warn(e) { this.warns.push(e); },
  error() {}, debug() {},
};

const protocolMod = await dist("protocol.js");
const typesMod = await dist("types.js");

// ===========================================================================
// 1. CSPRNG generation + no-Math.random source pins
// ===========================================================================
{
  assert.equal(typeof protocolMod.generateLaunchToken, "function",
    "generateLaunchToken is exported from protocol.js");

  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const token = protocolMod.generateLaunchToken();
    assert.match(token, /^[0-9a-f]{64}$/,
      "launch tokens are exactly 64 lowercase hex chars (randomBytes(32).toString('hex'))");
    seen.add(token);
  }
  assert.equal(seen.size, 64,
    "no launch token repeats across 64 draws (CSPRNG entropy, not a predictable PRNG)");

  // generateId keeps its historical wire shape: <base36 timestamp>-<6 base36 chars>.
  for (let i = 0; i < 8; i += 1) {
    assert.match(protocolMod.generateId(), /^[0-9a-z]+-[0-9a-z]{6}$/,
      "generateId output shape is unchanged (ts + 6-char fragment) so id consumers see no format drift");
  }

  // Source pins: the generator module is Math.random-free and the provisioner
  // no longer builds tokens from two generateId fragments.
  const protocolSrc = srcFile("protocol.ts");
  assert.doesNotMatch(protocolSrc, /Math\.random/,
    "protocol.ts no longer touches Math.random (issue #255 P0-1)");
  assert.match(protocolSrc, /randomBytes\(32\)\.toString\("hex"\)/,
    "the launch token is 32 CSPRNG bytes hex-encoded");

  const provisioningSrc = srcFile("controller/worker-provisioning.ts");
  assert.match(provisioningSrc, /const launchToken = generateLaunchToken\(\);/,
    "the provisioner mints launch tokens via generateLaunchToken");
  assert.doesNotMatch(provisioningSrc, /\$\{generateId\(\)\}-\$\{generateId\(\)\}/,
    "the old two-generateId (Math.random era) token construction is gone");

  // Whole-src tripwire: Math.random survives only in the two sanctioned
  // non-secret suffix generators. Any NEW Math.random under src/src must
  // consciously update this list (and must never generate a token).
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(p) : (p.endsWith(".ts") ? [p] : []);
  });
  const mathRandomHits = walk(path.join(projectRoot, "src", "src"))
    .filter((p) => /Math\.random/.test(fs.readFileSync(p, "utf8")))
    .map((p) => path.relative(path.join(projectRoot, "src", "src"), p))
    .sort();
  assert.deepEqual(
    mathRandomHits,
    ["openclaw-workspace.ts", "state.ts"],
    "Math.random remains only in the non-secret suffix generators (project slug in openclaw-workspace.ts, archive file-name suffix in state.ts) - no token/id generator uses it",
  );
}

// ===========================================================================
// 2. /team/status redaction on a real controller server
// ===========================================================================
{
  const httpMod = await dist("controller/http-server.js");
  const { TaskRouter } = await dist("controller/task-router.js");
  const { MessageRouter } = await dist("controller/message-router.js");
  const { TeamWebSocketServer } = await dist("controller/websocket.js");
  const loaderMod = await dist("profile-loader.js");
  const stateMod = await dist("state.js");

  loaderMod.setActiveProfileId("software-rd");
  const config = typesMod.parsePluginConfig({
    mode: "controller", teamName: "Launch Token Team", port: 19549, gitEnabled: false,
  });
  // A sentinel that also LOOKS like an old Math.random-era token, proving the
  // redaction is not format-dependent (upgrade deployments carry these).
  const SENTINEL = "mneoflrk-iepu3k-mneoflrk-nf2ss5";
  const teamState = {
    version: 2, profileId: "software-rd", teamName: "Launch Token Team",
    workers: {}, tasks: {}, controllerRuns: {}, projects: {}, messages: [], clarifications: {},
    provisioning: {
      workers: {
        "provisioned-dev-1": {
          workerId: "provisioned-dev-1", role: "dev", provider: "process", status: "launching",
          launchToken: SENTINEL, requestedAt: Date.now(), updatedAt: Date.now(),
        },
      },
    },
    createdAt: Date.now() - 1000, updatedAt: Date.now(),
  };
  const deps = {
    config, logger, runtime: {},
    getTeamState: () => teamState,
    updateTeamState: (updater) => { updater(teamState); void stateMod.saveTeamState(teamState); return teamState; },
    taskRouter: new TaskRouter(logger),
    messageRouter: new MessageRouter(logger),
    wsServer: new TeamWebSocketServer(logger),
  };
  const server = httpMod.createControllerHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/team/status`);
    assert.equal(res.status, 200, "GET /team/status answers 200");
    const text = await res.text();

    // VALUE: the plaintext token must not ride the wire in any position.
    assert.ok(!text.includes(SENTINEL),
      "the response body never contains the provisioning launchToken value (was: whole-LAN plaintext leak)");

    // KEY: no launchToken field survives anywhere in the parsed tree.
    const keyHits = [];
    (function walkTree(node) {
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "launchToken") keyHits.push(key);
          walkTree(value);
        }
      }
    })(JSON.parse(text));
    assert.deepEqual(keyHits, [],
      "no launchToken key anywhere in the /team/status JSON tree");

    // Redaction only: the non-secret provisioning metadata survives.
    const body = JSON.parse(text);
    const workers = body.provisioning?.workers ?? {};
    assert.ok(workers["provisioned-dev-1"],
      "the provisioning worker metadata entry survives redaction");
    assert.equal(workers["provisioned-dev-1"]?.status, "launching",
      "non-secret provisioning fields keep their values");
    assert.equal(workers["provisioned-dev-1"]?.role, "dev",
      "worker role metadata still readable by status consumers");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    deps.wsServer.close();
  }
}

// ===========================================================================
// 3. validateRegistration: constant-time pin + old-token compat behavior
// ===========================================================================
{
  const provisioningSrc = srcFile("controller/worker-provisioning.ts");
  assert.match(provisioningSrc, /!secretsEqual\(launchToken, record\.launchToken\)/,
    "validateRegistration compares launch tokens with the shared constant-time secretsEqual (issue #255 P0-1)");
  assert.doesNotMatch(provisioningSrc, /launchToken !== record\.launchToken/,
    "the old non-constant-time !== comparison is gone");
  assert.match(provisioningSrc, /import \{ secretsEqual \} from "\.\/security\.js";/,
    "secretsEqual is reused from controller security.ts (no duplicated timing helper)");

  // Behavioral compat: tokens minted by pre-#255 builds (Math.random era)
  // live on in upgraded TeamStates and must keep validating.
  const provisioningMod = await dist("controller/worker-provisioning.js");
  const config = typesMod.parsePluginConfig({
    mode: "controller", teamName: "Compat Team", port: 19550, gitEnabled: false,
  });
  const OLD_FORMAT_TOKEN = "mneoflrk-iepu3k-mneoflrk-nf2ss5";
  const record = (launchToken) => ({
    workerId: "provisioned-dev-1", role: "dev", provider: "process", status: "launching",
    launchToken, requestedAt: Date.now(), updatedAt: Date.now(),
  });
  const teamState = {
    version: 2, profileId: "software-rd", teamName: "Compat Team",
    workers: {}, tasks: {}, controllerRuns: {}, projects: {}, messages: [], clarifications: {},
    provisioning: { workers: { "provisioned-dev-1": record(OLD_FORMAT_TOKEN) } },
    createdAt: 0, updatedAt: 0,
  };
  const manager = new provisioningMod.WorkerProvisioningManager({
    config, logger,
    getTeamState: () => teamState,
    updateTeamState: (updater) => { updater(teamState); return teamState; },
  });

  assert.deepEqual(manager.validateRegistration("provisioned-dev-1", "dev", OLD_FORMAT_TOKEN), { ok: true, managed: true },
    "upgrade compat: an old Math.random-era token still validates (equality semantics unchanged, only constant-timed)");
  assert.equal(manager.validateRegistration("provisioned-dev-1", "dev", `${OLD_FORMAT_TOKEN.slice(0, -1)}x`).ok, false,
    "a wrong old-format token is rejected");
  assert.equal(manager.validateRegistration("provisioned-dev-1", "dev", undefined).ok, false,
    "a missing token is rejected");
  assert.equal(manager.validateRegistration("provisioned-dev-1", "pm", OLD_FORMAT_TOKEN).ok, false,
    "role mismatch still rejects first");

  const newToken = protocolMod.generateLaunchToken();
  teamState.provisioning.workers["provisioned-dev-1"] = record(newToken);
  assert.deepEqual(manager.validateRegistration("provisioned-dev-1", "dev", newToken), { ok: true, managed: true },
    "new 256-bit CSPRNG tokens validate through the same path");
  assert.deepEqual(manager.validateRegistration("unmanaged-worker", "dev", undefined), { ok: true, managed: false },
    "unmanaged workers keep the no-record bypass");
}

// ===========================================================================
// 4. TeamState file mode 0600 (P1-4) - POSIX assertions
// ===========================================================================
if (process.platform !== "win32") {
  const stateMod = await dist("state.js");
  const stateDir = path.join(stateRoot, "plugins", "teamclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "team-state.json");
  const mkState = (teamName) => ({
    version: 2, profileId: "software-rd", teamName,
    workers: {}, tasks: {}, controllerRuns: {}, projects: {}, messages: [], clarifications: {},
    provisioning: { workers: {} },
    createdAt: Date.now(), updatedAt: Date.now(),
  });

  // Fresh write (no prior file): created owner-only.
  await stateMod.saveTeamState(mkState("Perm Team"));
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600,
    "team-state.json is created 0600 (issue #255 P1-4 - it holds plaintext pairingCode/launchToken)");

  // Upgrade path: an older build left the file 0644 - the next save tightens it.
  fs.writeFileSync(stateFile, "{}\n", { mode: 0o644 });
  fs.chmodSync(stateFile, 0o644); // explicit widen, umask-proof
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o644,
    "fixture: the pre-existing file really is 0644 before the save");
  await stateMod.saveTeamState(mkState("Perm Team 2"));
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600,
    "a pre-existing 0644 team-state.json is tightened to 0600 on rewrite (chmod-on-rewrite)");

  // worker-identity.json rides the same atomic-write helper.
  await stateMod.saveWorkerIdentity({
    workerId: "w1", role: "dev", controllerUrl: "http://127.0.0.1:1", registeredAt: Date.now(),
  });
  assert.equal(fs.statSync(path.join(stateDir, "worker-identity.json")).mode & 0o777, 0o600,
    "worker-identity.json is 0600 too (same writeFileAtomically path)");
}

console.log("LaunchToken hardening (#255 P0-1 + P1-4) passed.");
