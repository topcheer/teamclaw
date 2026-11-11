#!/usr/bin/env node
// #255 P1-5: quick (*.trycloudflare.com) tunnels must be gate-gated.
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/src/controller/tunnel-manager.ts", import.meta.url), "utf8");

assert.ok(
  src.includes('host.endsWith(TUNNEL_HOST_SUFFIX) || host.endsWith(".trycloudflare.com")'),
  "isTunnelRequest must treat *.trycloudflare.com hosts as tunnel traffic (gate enforcement point)",
);
assert.ok(
  /tunnelId: "quick", hostname: "", gateToken: randomBytes\(16\)\.toString\("base64url"\)/.test(src),
  "startQuick must mint a 16-byte CSPRNG gate token (same class as managed tunnels)",
);
assert.ok(
  !src.includes("No TeamClaw gate: anyone with the URL can reach the dashboard"),
  "the stale self-admitted bypass comment must be gone",
);
// Functional pin on the shared cookie derivation: gateAllows uses
// gateCookieValue(handle.gateToken, handle.tunnelId) so a quick handle with
// a real token is enforced by the exact same http-server code path.
assert.ok(
  /gateCookieValue\(handle\.gateToken, handle\.tunnelId\)/.test(src),
  "gateAllows must keep deriving the cookie from the handle token (shared quick/managed path)",
);

console.log("test-tunnel-quick-gate: ok (quick tunnels mint + enforce gate tokens)");
