#!/usr/bin/env node
// Issue #237 (residuals of #222): regression locks for the three leftover
// security warnings.
//
//   W3  tunnel gate token entropy + constant-time verify + rate limit:
//       - source pin: gate tokens are randomBytes(16) base64url (>=128
//         bits), the ~41-bit 8-char derivation is gone;
//       - source pin: verify compares via the exported security.ts
//         secretsEqual (constant time), never a plain ===;
//       - dist-level behavior: POST /__tunnel_gate/verify answers 302 with
//         the gate cookie on the right token, 403 on wrong tokens, and
//         after GATE_VERIFY_FAILURE_MAX failures cools down with 429 +
//         Retry-After (even for the CORRECT token - the throttle check
//         runs before any comparison).
//   W4  bootstrap config permissions:
//       - source pin: the process provisioner writes openclaw.json (which
//         carries provider API keys) with mode 0o600, and the container
//         bootstrap script does the same inside docker/k8s workers;
//       - POSIX behavior check: Node's fs.writeFile honors { mode: 0o600 }
//         on this platform (documents why the pin is load-bearing).
//   W1  previewCommand env policy:
//       - source pin: preview spawns never spread ...process.env; both the
//         preview command and the pip pre-install go through
//         buildPreviewEnv (allowlist + TEAMCLAW_PREVIEW_EXTRA_ENV hatch);
//       - dist-level behavior: buildPreviewEnv drops credential-bearing
//         sentinel vars, keeps toolchain basics, forwards declared extras
//         (case-insensitively) and merges extraEnv last.
//
// Requires the dist build first: npm --prefix src run build

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const readSource = (rel) => fs.readFileSync(path.join(projectRoot, rel), "utf8");

// --- env must be in place before the first dist import ---------------------
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sec-residuals-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-sec-residuals-ws-"));

const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// ===========================================================================
// W3 - tunnel gate token entropy + constant-time verify + rate limit
// ===========================================================================
{
  const mgrSource = readSource(path.join("src", "src", "controller", "tunnel-manager.ts"));
  const routesSource = readSource(path.join("src", "src", "controller", "tunnel-routes.ts"));
  const securitySource = readSource(path.join("src", "src", "controller", "security.ts"));

  // Token generation length pin: 16 random bytes kept as base64url = the
  // full 128 bits in 22 case-sensitive chars.
  assert.match(
    mgrSource,
    /randomBytes\(16\)\.toString\("base64url"\)/,
    "gate tokens must be generated as randomBytes(16).toString('base64url') (>=128 bits, #237 W3)",
  );
  assert.doesNotMatch(
    mgrSource,
    /randomBytes\(6\)\.toString\("base64url"\)/,
    "the ~41-bit 8-char gate token derivation must stay retired (#237 W3)",
  );

  // Constant-time verify pin: the compare goes through the exported
  // secretsEqual helper, never a plain ===.
  assert.match(
    securitySource,
    /export function secretsEqual/,
    "security.ts must export secretsEqual for reuse by the tunnel gate verify (#237 W3)",
  );
  assert.match(
    routesSource,
    /secretsEqual\(submitted, st\.gateToken\)/,
    "gate verify must compare tokens via secretsEqual (constant time, #237 W3)",
  );
  assert.doesNotMatch(
    routesSource,
    /submitted === st\.gateToken/,
    "plain === token comparison must stay retired on the gate verify route (#237 W3)",
  );

  // Rate limit pins: 10 failures / 60s cooldown, throttle checked BEFORE
  // the token is read or compared, failure recorded on every 403 path.
  assert.match(routesSource, /GATE_VERIFY_FAILURE_MAX = 10/, "gate verify throttle: 10 failures (#237 W3)");
  assert.match(routesSource, /GATE_VERIFY_COOLDOWN_MS = 60_000/, "gate verify cooldown: 60s (#237 W3)");
  const handlerMatch = routesSource.match(/path: "\/__tunnel_gate\/verify",[\s\S]*?\n      \},/);
  assert.ok(handlerMatch, "the gate verify route handler must be found in tunnel-routes.ts");
  const handlerBody = handlerMatch[0];
  const throttleIdx = handlerBody.indexOf("gateVerifyThrottled()");
  const readIdx = handlerBody.indexOf("readFormBody");
  const compareIdx = handlerBody.indexOf("secretsEqual(submitted");
  assert.ok(throttleIdx >= 0 && readIdx > throttleIdx && compareIdx > readIdx,
    "gate verify must check the throttle BEFORE reading/comparing the token (#237 W3)");
  assert.match(handlerBody, /recordGateVerifyFailure\(\);/,
    "every failed gate verify must record a failure for the throttle (#237 W3)");
}

// W3 dist-level behavior: right token 302 + cookie, wrong token 403 x10,
// then 429 cooldown even for the correct token.
{
  const routeTableMod = await dist("controller/route-table.js");
  const tunnelManagerMod = await dist("controller/tunnel-manager.js");

  const GATE_TOKEN = "c3VyZSxseS0xMjgtYml0cw"; // shape of a base64url token (not a secret)
  const TUNNEL_ID = "t-237";
  const tunnelManager = {
    status: () => ({ active: true, gateToken: GATE_TOKEN, tunnelId: TUNNEL_ID }),
  };
  const gateRoutes = routeTableMod.createTunnelGateRoutes(tunnelManager);
  const verifyRoute = gateRoutes.find((route) => route.path === "/__tunnel_gate/verify");
  assert.ok(verifyRoute, "the gate route table must contain POST /__tunnel_gate/verify");

  const makeReq = (formBody) => ({
    headers: { host: "share.teamclaw.dev" },
    method: "POST",
    url: "/__tunnel_gate/verify",
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(formBody);
    },
  });
  const makeRes = () => {
    const res = { statusCode: 0, headers: {}, bodyChunks: [] };
    res.getHeader = (k) => res.headers[String(k).toLowerCase()];
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = String(v); };
    res.writeHead = (code, hdrs) => {
      res.statusCode = code;
      for (const [k, v] of Object.entries(hdrs ?? {})) res.headers[k.toLowerCase()] = String(v);
    };
    res.end = (b) => { res.bodyChunks.push(String(b ?? "")); };
    return res;
  };
  const verify = async (token) => {
    const res = makeRes();
    await verifyRoute.handler({ res, req: makeReq(`token=${encodeURIComponent(token)}`) });
    return res;
  };

  // 1. Correct token BEFORE any failures: 302 + the derived gate cookie.
  const ok = await verify(GATE_TOKEN);
  assert.equal(ok.statusCode, 302, "correct gate token verifies (302 to /)");
  const setCookie = ok.headers["set-cookie"];
  assert.ok(setCookie, "verify sets the gate cookie on success");
  assert.match(
    setCookie,
  new RegExp(`^${tunnelManagerMod.GATE_COOKIE_NAME}=${tunnelManagerMod.computeGateCookie(GATE_TOKEN, TUNNEL_ID)};`),
    "the gate cookie value is the sha256 derivation of (gateToken, tunnelId)",
  );
  assert.match(setCookie, /HttpOnly; SameSite=Lax/, "the gate cookie keeps HttpOnly + SameSite=Lax");

  // 2. Wrong tokens: GATE_VERIFY_FAILURE_MAX 403s with the wrong-token page.
  for (let i = 0; i < 10; i++) {
    const wrong = await verify("WRONG-GUESS-" + i);
    assert.equal(wrong.statusCode, 403, `wrong gate token #${i + 1} answers 403`);
    assert.match(wrong.bodyChunks.join(""), /Wrong token, try again\./, "403 renders the wrong-token gate page");
  }

  // 3. Cooldown: even the CORRECT token now answers 429 + Retry-After,
  //    proving the throttle is checked before any comparison.
  const cooled = await verify(GATE_TOKEN);
  assert.equal(cooled.statusCode, 429, "after 10 failures the gate verify cools down (429)");
  assert.equal(cooled.headers["retry-after"], "60", "cooldown advertises Retry-After: 60");
  assert.match(cooled.bodyChunks.join(""), /Too many gate verification attempts/, "429 body names the throttle");
}

// ===========================================================================
// W4 - bootstrap config written owner-only (provider API keys inside)
// ===========================================================================
{
  const supervisorSource = readSource(path.join("src", "src", "controller", "provisioning", "process-supervisor.ts"));
  const containerSource = readSource(path.join("src", "src", "controller", "provisioning", "container-shared.ts"));

  assert.match(
    supervisorSource,
    /fs\.writeFile\(configPath, spec\.configJson, \{ encoding: "utf8", mode: 0o600 \}\)/,
    "process provisioner must write the bootstrap openclaw.json with mode 0o600 (#237 W4)",
  );
  assert.doesNotMatch(
    supervisorSource,
    /fs\.writeFile\(configPath, spec\.configJson, "utf8"\)/,
    "the permissionless process-mode config write must stay retired (#237 W4)",
  );
  assert.match(
    containerSource,
    /fs\.writeFileSync\(configPath, raw, \{ mode: 0o600 \}\)/,
    "container bootstrap script must write the config 0600 inside the worker (#237 W4)",
  );

  // POSIX semantics check (skipped loudly on Windows): the { mode } option
  // is what separates 0600 from the umask default 0644 - pin it so the
  // source pin above stays load-bearing on this platform.
  if (process.platform === "win32") {
    console.log("test-security-residuals-237: NOTE - skipping the POSIX mode check on win32 (no POSIX perms).");
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-w4-mode-"));
    const permissive = path.join(dir, "old-style.json");
    const restricted = path.join(dir, "new-style.json");
    fs.writeFileSync(permissive, "{}", "utf8");
    fs.writeFileSync(restricted, "{}", { encoding: "utf8", mode: 0o600 });
    const permissiveMode = fs.statSync(permissive).mode & 0o777;
    const restrictedMode = fs.statSync(restricted).mode & 0o777;
    assert.equal(restrictedMode, 0o600, "fs.writeFile honors { mode: 0o600 } on POSIX (#237 W4)");
    assert.notEqual(permissiveMode, 0o600, "the old permissionless write stays group/other-readable - the fix is not a no-op");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// W1 - previewCommand env policy (allowlist, never the controller env)
// ===========================================================================
{
  const previewSource = readSource(path.join("src", "src", "controller", "preview-manager.ts"));

  // Source pins: no spawn site spreads the controller env; both the preview
  // command and the pip pre-install go through the restricted builder.
  assert.doesNotMatch(
    previewSource,
    /env: \{\s*\.\.\.process\.env/,
    "preview subprocess env must never spread ...process.env (#237 W1)",
  );
  const pipSite = previewSource.match(/command: `\$\{pipBin\} install -q -r requirements\.txt`,[\s\S]*?env: ([^\n]+),/);
  assert.ok(pipSite, "the pip pre-install spawn site must be found");
  assert.match(pipSite[1], /buildPreviewEnv\(extraEnv\)/,
    "pip pre-install (runs worker-influenced requirements.txt) uses the restricted env (#237 W1)");
  const previewSite = previewSource.match(/command: resolvedCommand,[\s\S]*?env: \{[\s\S]*?\},\s*\}\);/);
  assert.ok(previewSite, "the preview command spawn site must be found");
  assert.match(previewSite[0], /\.\.\.buildPreviewEnv\(extraEnv\)/,
    "the preview command env starts from buildPreviewEnv, not process.env (#237 W1)");
  assert.match(previewSite[0], /HOST: "0\.0\.0\.0"/, "the explicit preview vars (HOST/PORT/TEAMCLAW_PREVIEW_*) are still set");
  assert.match(previewSource, /PREVIEW_EXTRA_ENV_VAR = "TEAMCLAW_PREVIEW_EXTRA_ENV"/,
    "the operator escape hatch TEAMCLAW_PREVIEW_EXTRA_ENV is declared (#237 W1)");

  // Dist-level behavior of the exported builder.
  const { buildPreviewEnv } = await dist("controller/preview-manager.js");
  const SENTINEL = "TEAMCLAW_237_SENTINEL_SECRET";
  const extrasBefore = process.env.TEAMCLAW_PREVIEW_EXTRA_ENV;
  try {
    process.env[SENTINEL] = "credential-material-237";
    delete process.env.TEAMCLAW_PREVIEW_EXTRA_ENV;

    const env = buildPreviewEnv({});
    assert.equal(env[SENTINEL], undefined, "credential-bearing env vars are dropped (#237 W1)");
    assert.ok(env.PATH ?? env.Path, "PATH survives the allowlist (commands must still resolve)");
    assert.ok(env.HOME ?? env.USERPROFILE, "HOME/USERPROFILE survives the allowlist");

    const withExtraEnv = buildPreviewEnv({ VIRTUAL_ENV: "/ws/venv" });
    assert.equal(withExtraEnv.VIRTUAL_ENV, "/ws/venv", "extraEnv (venv vars) merges through");
    assert.equal(withExtraEnv[SENTINEL], undefined, "extraEnv merge does not widen the policy");

    // Escape hatch: declared names are forwarded; matching is case-insensitive.
    process.env.TEAMCLAW_PREVIEW_EXTRA_ENV = "teamclaw_237_sentinel_secret";
    const escaped = buildPreviewEnv({});
    assert.equal(escaped[SENTINEL], "credential-material-237",
      "TEAMCLAW_PREVIEW_EXTRA_ENV forwards declared names (case-insensitive) - the deliberate operator opt-in");
  } finally {
    delete process.env[SENTINEL];
    if (extrasBefore === undefined) {
      delete process.env.TEAMCLAW_PREVIEW_EXTRA_ENV;
    } else {
      process.env.TEAMCLAW_PREVIEW_EXTRA_ENV = extrasBefore;
    }
  }
}

console.log("test-security-residuals-237: all assertions passed (#237 W3 gate token/verify/throttle, W4 config perms, W1 preview env policy).");
