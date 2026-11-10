#!/usr/bin/env node
// Issue #223 (desktop P0) security-regression tests: renderer->main command
// injection chain + gateway process lifecycle. Source-level assertions in the
// test-ui-contracts.mjs style (no Electron), PLUS behavioral checks that
// extract the REAL functions from desktop/main.mjs and run them (the
// test-bundled-dep-seal.mjs pattern): a URL validator is only trusted once a
// crafted injection payload has actually bounced off it.
//
//   C1  artifactUrl command injection - shell curl is gone; validated Node
//       fetch download + node:crypto sha256; the ".sha256" companion fetch
//       goes through the SAME validated URL (SSRF surface is shared).
//   C2  dead RCE IPC (installOpenClawLocally / installLocalTeamClaw) removed.
//   W1  openExternal/openPath refuse non-http(s) URLs / non-absolute paths.
//   W2  CSP meta in renderer/index.html (script hash pinned to the real
//       inline bootstrap, no unsafe-inline for scripts).
//   W3  gateway spawns are shell-free (execPath + ELECTRON_RUN_AS_NODE),
//       killed by process group with SIGKILL escalation, before-quit is
//       synchronous w.r.t. the cached instance record, log fds closed.
//   W4  runShellStream stdout accounting (stdout accumulated, stderr not
//       double-counted) - verified behaviorally on a real child process.
//   W5  will-navigate / setWindowOpenHandler guards exist.
//   #220 openclaw probe pre-resolves the executable (no PATH-dependent spawn,
//       no bare "openclaw") and hard-kills a hung --help after a timeout.
//   #223 DNS-rebinding follow-up: validateArtifactUrl only saw the hostname
//       STRING - https://localtest.me (public DNS -> 127.0.0.1) passed it
//       untouched. Every fetch hop now RESOLVES non-literal hosts
//       (dns.lookup all:true) and rejects any private-range address,
//       fail-closed on DNS failure/timeout; literal IPs never hit DNS.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const desktopDir = path.join(projectRoot, "desktop");
const mainPath = path.join(desktopDir, "main.mjs");
const preloadPath = path.join(desktopDir, "preload.cjs");
const htmlPath = path.join(desktopDir, "renderer", "index.html");
const appJsPath = path.join(desktopDir, "renderer", "app.js");

const [mainSource, preloadSource, htmlSource, appJsSource] = await Promise.all([
  fs.readFile(mainPath, "utf8"),
  fs.readFile(preloadPath, "utf8"),
  fs.readFile(htmlPath, "utf8"),
  fs.readFile(appJsPath, "utf8"),
]);

// ---------------------------------------------------------------------------
// Helpers: extract a whole function from main.mjs and evaluate it with the
// stdlib globals it uses (string/comment-aware brace scan).
// ---------------------------------------------------------------------------
function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `main.mjs must define ${name}()`);
  // keep a preceding `async` modifier when present
  if (start >= 6 && source.slice(start - 6, start) === "async ") start -= 6;
  // Skip the balanced parameter list first: a destructured parameter like
  // `{ cwd, env }` would otherwise truncate the extraction at its brace.
  const parenOpen = source.indexOf("(", start);
  let i = parenOpen;
  let parenDepth = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { i += 1; break; }
    }
    i += 1;
  }
  const open = source.indexOf("{", i);
  let depth = 0;
  i = open;
  let quote = null;
  let prevSignificant = "";
  const REGEX_PRECEDERS = new Set(["(", "=", ",", ":", "[", "!", "&", "|", "?", ";", "{", "}", "+", "-", "*", "%", "~", "^", "<", ">", "\n"]);
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; prevSignificant = ch; i += 1; continue; }
    // comments
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i + 2) + 2;
      continue;
    }
    // regex literal (quote chars inside a character class would otherwise
    // knock the scanner into string mode)
    if (ch === "/" && REGEX_PRECEDERS.has(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const rch = source[j];
        if (rch === "\\") { j += 2; continue; }
        if (rch === "[") inClass = true;
        else if (rch === "]") inClass = false;
        else if (rch === "/" && !inClass) break;
        j += 1;
      }
      i = j + 1;
      prevSignificant = "/";
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  throw new Error(`${name}() body is not balanced`);
}

function evalWithDeps(decl, deps) {
  const names = Object.keys(deps);
  const factory = new Function(...names, `return (${decl});`);
  return factory(...names.map((n) => deps[n]));
}

// ---------------------------------------------------------------------------
// C1: no shell curl/shasum anywhere in the download path; fetch + node:crypto.
// ---------------------------------------------------------------------------
assert.ok(!mainSource.includes("curl -fSL"), "the shell curl download must be gone (C1)");
assert.ok(!mainSource.includes("shasum -a"), "the shell shasum call must be gone (C1)");
// The only remaining shell:true spawns are the npm/CLI stream commands with
// app-owned strings - never a renderer-supplied URL.
for (const m of mainSource.matchAll(/runShellStream\((`[^`]*)/g)) {
  assert.ok(!m[1].includes("${url"), `runShellStream must not interpolate a URL: ${m[1].slice(0, 60)}`);
}
assert.match(mainSource, /async function downloadArtifact\(/, "fetch-based download must exist (C1)");
// Cross-review SSRF fix: fetch must NEVER follow redirects on its own - every
// hop goes through validatedArtifactFetch and is re-validated.
assert.match(mainSource, /async function validatedArtifactFetch\(/, "manual-redirect fetch wrapper must exist");
assert.match(mainSource, /redirect: "manual"/, "redirects must be followed manually (hop-by-hop re-validation)");
assert.ok(!mainSource.includes('redirect: "follow"'), "no fetch may follow redirects itself (302 -> intranet bypass)");
assert.match(mainSource, /const \{ createHash \} = await import\("node:crypto"\)/, "sha256 must be computed with node:crypto (C1)");
assert.match(mainSource, /await runSpawnStream\(tarBinary\(\), \["xzf", dest, "-C", extractDir\]/, "tar extraction must use an argv array, not a shell string (C1)");
// #223 DNS-rebinding follow-up: hostname-string validation alone let public
// names that RESOLVE into the intranet through (localtest.me -> 127.0.0.1).
assert.match(mainSource, /import dns from "node:dns\/promises"/, "the DNS gate must use node:dns/promises");
assert.match(mainSource, /dns\.lookup\(effectiveHost, \{ all: true \}\)/, "dns.lookup must request ALL addresses (every A/AAAA record is checked)");
assert.match(mainSource, /await assertArtifactHostResolvesPublic\(current\)/, "every fetch hop (first request + each redirect) must pass the DNS gate");
assert.match(mainSource, /const ARTIFACT_DNS_TIMEOUT_MS = \d+/, "the DNS gate must have an explicit timeout budget");
// #246 NAT64: the 64:ff9b::/96 unwrap must live in the SHARED pure layer
// (artifactEffectiveHost), so the textual validator and the DNS re-check
// both judge the embedded IPv4 automatically.
assert.match(mainSource, /function nat64EmbeddedIpv4\(/, "the NAT64 64:ff9b::/96 unwrap helper must exist (#246)");
assert.match(
  mainSource,
  /const nat64 = nat64EmbeddedIpv4\(host\);/,
  "artifactEffectiveHost must consult the NAT64 unwrap (#246)",
);

// C1 behavioral: run the REAL validator against injection payloads. The
// blocklist lives in shared helpers (artifactEffectiveHost unwrap +
// nat64EmbeddedIpv4 + isBlockedArtifactHost predicate) so the textual check
// and the DNS re-check below provably run the SAME rules.
const nat64EmbeddedIpv4 = evalWithDeps(extractFunction(mainSource, "nat64EmbeddedIpv4"), {});
const artifactEffectiveHost = evalWithDeps(extractFunction(mainSource, "artifactEffectiveHost"), {
  nat64EmbeddedIpv4,
});
const isBlockedArtifactHost = evalWithDeps(extractFunction(mainSource, "isBlockedArtifactHost"), {});
const isLiteralIpHost = evalWithDeps(extractFunction(mainSource, "isLiteralIpHost"), {});
const validateArtifactUrl = evalWithDeps(extractFunction(mainSource, "validateArtifactUrl"), {
  artifactEffectiveHost,
  isBlockedArtifactHost,
});
const artifactFileNameFromUrl = evalWithDeps(
  extractFunction(mainSource, "artifactFileNameFromUrl"),
  { path },
);
const GOOD_URL = "https://github.com/topcheer/teamclaw/releases/download/runtime-latest/teamclaw-runtime-darwin-arm64.tar.gz";
assert.equal(validateArtifactUrl(GOOD_URL).href, GOOD_URL, "the default release URL must validate");
assert.equal(
  artifactFileNameFromUrl(validateArtifactUrl(GOOD_URL)),
  "teamclaw-runtime-darwin-arm64.tar.gz",
  "filename derives from the validated URL path",
);
for (const [label, payload] of [
  ["quote injection", 'https://github.com/x/a.tar.gz"; touch /tmp/pwned #'],
  ["command substitution", "https://github.com/x/$(id).tar.gz"],
  ["plain http", "http://github.com/topcheer/teamclaw/releases/download/runtime-latest/x.tar.gz"],
  ["loopback host", "https://127.0.0.1/x.tar.gz"],
  ["localhost", "https://localhost/x.tar.gz"],
  ["private v4", "https://192.168.1.5/x.tar.gz"],
  ["private v4 (172)", "https://172.16.0.1/x.tar.gz"],
  ["cloud metadata", "https://169.254.169.254/latest/meta-data"],
  ["gce metadata host", "https://metadata.google.internal/x"],
  ["embedded credentials", "https://user:pass@github.com/x.tar.gz"],
  ["v4-mapped loopback (dotted)", "https://[::ffff:127.0.0.1]/x.tar.gz"],
  ["v4-mapped loopback (hex, URL-normalized)", "https://[::ffff:7f00:1]/x.tar.gz"],
  ["v4-mapped metadata (hex)", "https://[::ffff:a9fe:a9fe]/x.tar.gz"],
  ["v4-mapped private v4 (hex)", "https://[::ffff:c0a8:101]/x.tar.gz"],
  ["v4-compatible loopback (hex)", "https://[::7f00:1]/x.tar.gz"],
  // #246 NAT64: 64:ff9b::/96 embeds the IPv4 target in the low 32 bits - the
  // textual v6 rules see nothing wrong while the gateway dials the intranet.
  ["NAT64-embedded loopback v4", "https://[64:ff9b::7f00:1]/x.tar.gz"],
  ["NAT64-embedded private v4 (10/8)", "https://[64:ff9b::a00:1]/x.tar.gz"],
  ["NAT64-embedded private v4 (172.16/12)", "https://[64:ff9b::ac10:1]/x.tar.gz"],
  ["NAT64-embedded private v4 (192.168/16)", "https://[64:ff9b::c0a8:101]/x.tar.gz"],
  ["NAT64-embedded cloud metadata", "https://[64:ff9b::a9fe:a9fe]/x.tar.gz"],
  ["NAT64-embedded metadata (dotted in v6)", "https://[64:ff9b::169.254.169.254]/x.tar.gz"],
  ["NAT64-embedded private v4 (full 8-group form)", "https://[64:ff9b:0:0:0:0:a00:1]/x.tar.gz"],
  ["not a url", "just-some-text"],
  ["empty", ""],
]) {
  assert.throws(() => validateArtifactUrl(payload), /https|not allowed|credentials|characters|Invalid/i, `${label} payload must be rejected: ${payload}`);
}
// #246 NAT64 (behavioral, pass side): an embedded PUBLIC v4 must stay
// allowed - NAT64 to the internet is a legitimate network setup; only the
// embedded private/loopback/metadata ranges reject.
assert.equal(
  validateArtifactUrl("https://[64:ff9b::808:808]/x.tar.gz").href,
  "https://[64:ff9b::808:808]/x.tar.gz",
  "NAT64 embedding a public v4 (8.8.8.8) must stay allowed",
);
// #246 NAT64 (behavioral, unwrap unit): the shared pure helper extracts the
// embedded v4 from every textual form (bracketed URL form, the URL parser's
// canonical compressed form, the full 8-group form dns.lookup can return).
assert.equal(artifactEffectiveHost("[64:ff9b::a00:1]"), "10.0.0.1", "NAT64 unwrap: [64:ff9b::a00:1] -> 10.0.0.1");
assert.equal(artifactEffectiveHost("64:ff9b:0:0:0:0:a00:1"), "10.0.0.1", "NAT64 unwrap: full 8-group form -> 10.0.0.1");
assert.equal(artifactEffectiveHost("64:ff9b::808:808"), "8.8.8.8", "NAT64 unwrap: public embedded v4 -> 8.8.8.8");
assert.equal(artifactEffectiveHost("64:ff9b::"), "0.0.0.0", "NAT64 unwrap: all-zero tail is the 0.0.0.0 'this network' address");
assert.equal(artifactEffectiveHost("64:ff9c::a00:1"), "64:ff9c::a00:1", "a NEAR miss (64:ff9c, not the well-known 64:ff9b::/96) must NOT be unwrapped");
// Cross-review SSRF fix (behavioral): every redirect hop goes through the
// SAME validator - a public https URL that 302s to the intranet must bounce
// at the next hop (with redirect:"follow" the loopback response body was
// fully readable). Also proves undici's redirect:"manual" hands the 30x
// back to us (status + Location readable), which the wrapper relies on.
{
  const base = validateArtifactUrl("https://github.com/topcheer/teamclaw/releases/download/runtime-latest/x.tar.gz");
  assert.equal(
    validateArtifactUrl(new URL("/other/y.tar.gz", base).href).href,
    "https://github.com/other/y.tar.gz",
    "relative redirects stay on the validated https origin",
  );
  for (const location of [
    "http://127.0.0.1:8080/pwned",
    "https://192.168.0.9/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::ffff:7f00:1]/x",
    "file:///etc/passwd",
  ]) {
    assert.throws(
      () => validateArtifactUrl(new URL(location, base).href),
      /https|not allowed|Invalid/i,
      `a redirect hop to ${location} must be re-validated and rejected`,
    );
  }
  const { default: http } = await import("node:http");
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:9/inner" });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
  try {
    const hop = await fetch(`http://127.0.0.1:${redirector.address().port}/`, { redirect: "manual" });
    assert.equal(hop.status, 302, "undici redirect:manual returns the 30x itself");
    assert.equal(hop.headers.get("location"), "http://127.0.0.1:9/inner", "the Location header is readable for hop re-validation");
  } finally {
    redirector.close();
  }
}
// ---------------------------------------------------------------------------
// #223 DNS-rebinding follow-up (behavioral): run the REAL gate - with
// stubbed dns.lookup (private/public/failure/empty/hang resolver states) and
// against the real resolver for the original proof-of-bypass domain.
// ---------------------------------------------------------------------------
const realDns = await import("node:dns/promises");
const dnsGate = (dnsImpl) =>
  evalWithDeps(extractFunction(mainSource, "assertArtifactHostResolvesPublic"), {
    dns: dnsImpl,
    artifactEffectiveHost,
    isBlockedArtifactHost,
    isLiteralIpHost,
    ARTIFACT_DNS_TIMEOUT_MS: 2500,
  });
// dns.lookup stub: a fixed answer set, a thrown getaddrinfo error, or a
// resolver that never answers at all.
const dnsStub = (addresses, opts = {}) => ({
  lookup: async (hostname, options) => {
    if (opts.throw) {
      throw Object.assign(new Error(opts.throw), { code: opts.code || "ENOTFOUND" });
    }
    if (opts.hang) return new Promise(() => {});
    assert.equal(options?.all, true, "dns.lookup must request { all: true } so every A/AAAA record is checked");
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
});
{
  const publicUrl = new URL("https://rebind.example/x.tar.gz");
  // A fully public answer set passes the gate.
  await dnsGate(dnsStub(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]))(publicUrl);
  // #246 NAT64 on the DNS path: a public NAME whose AAAA answer is a NAT64
  // address embedding an intranet v4 must reject; embedding a public v4 passes.
  await dnsGate(dnsStub(["64:ff9b::808:808"]))(publicUrl);
  await assert.rejects(
    () => dnsGate(dnsStub(["64:ff9b::a9fe:a9fe"]))(publicUrl),
    /blocked address/,
    "a DNS64 answer embedding the metadata v4 (169.254.169.254) must be rejected",
  );
  // ANY private/loopback/link-local/metadata address in the answer set
  // rejects - the localtest.me shape: public NAME, intranet ADDRESS.
  for (const [label, addresses] of [
    ["loopback v4", ["127.0.0.1"]],
    ["private v4 among public", ["93.184.216.34", "10.1.2.3"]],
    ["private v4 (172.16/12)", ["172.31.255.1"]],
    ["cloud metadata v4", ["169.254.169.254"]],
    ["v4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["NAT64-embedded private v4", ["64:ff9b::a00:1"]],
    ["NAT64-embedded loopback v4 (full form)", ["64:ff9b:0:0:0:0:7f00:1"]],
    ["private v6", ["fd12:3456:789a::1"]],
    ["link-local v6", ["fe80::1"]],
  ]) {
    await assert.rejects(
      () => dnsGate(dnsStub(addresses))(publicUrl),
      /blocked address|not allowed/,
      `${label} resolution must be rejected (${addresses.join(", ")})`,
    );
  }
  // DNS failure / empty answer: FAIL-CLOSED - the download refuses rather
  // than falling back to connecting anyway.
  await assert.rejects(
    () => dnsGate(dnsStub([], { throw: "getaddrinfo ENOTFOUND rebind.example" }))(publicUrl),
    /fail-closed/,
    "an unresolvable host must fail closed",
  );
  await assert.rejects(
    () => dnsGate(dnsStub([]))(publicUrl),
    /fail-closed/,
    "an empty answer set must fail closed",
  );
  // A resolver that never answers is bounded by the timeout budget.
  {
    const t0 = Date.now();
    await assert.rejects(
      () => dnsGate(dnsStub([], { hang: true }))(publicUrl),
      /could not be resolved \(fail-closed\): DNS lookup timed out after \d+ms/,
      "a hung resolver must be cut off by the DNS timeout (fail-closed)",
    );
    const waited = Date.now() - t0;
    assert.ok(waited >= 2400 && waited < 15000, `the timeout must bound the DNS wait (~2.5s, waited ${waited}ms)`);
  }
  // Literal IP hosts must never trigger DNS at all - the textual blocklist
  // already judged them character-for-character.
  {
    let lookups = 0;
    const guard = dnsGate({
      lookup: async () => {
        lookups += 1;
        return [{ address: "127.0.0.1", family: 4 }];
      },
    });
    await guard(new URL("https://93.184.216.34/x.tar.gz")); // dotted quad
    await guard(new URL("https://[2606:2800:220:1:248:1893:25c8:1946]/x.tar.gz")); // IPv6 literal
    assert.equal(lookups, 0, "literal IP hosts must be judged directly - dns.lookup must never fire for them");
  }
}
// Real resolver: localtest.me is a PUBLIC DNS name that resolves to
// 127.0.0.1 - the exact vector that sailed through the string-only check.
{
  const gate = dnsGate(realDns);
  let online = true;
  try {
    await gate(new URL("https://github.com/topcheer/teamclaw/x.tar.gz"));
  } catch (e) {
    online = false;
    assert.match(String(e.message), /fail-closed/, "offline DNS failure must refuse the download, never pass it");
  }
  const localtest = online ? await realDns.lookup("localtest.me", { all: true }).catch(() => null) : null;
  if (localtest?.length) {
    assert.ok(
      localtest.some((a) => a.address === "127.0.0.1"),
      `precondition: localtest.me must resolve to 127.0.0.1 (got ${JSON.stringify(localtest)})`,
    );
    await assert.rejects(
      () => gate(new URL("https://localtest.me/x.tar.gz")),
      /blocked address 127\.0\.0\.1/,
      "https://localtest.me (public DNS -> 127.0.0.1) must now be rejected",
    );
  } else {
    // Offline environment: the gate must still REFUSE localtest.me (a
    // resolver-less world is fail-closed), never let it through.
    await assert.rejects(() => gate(new URL("https://localtest.me/x.tar.gz")), /fail-closed|blocked address/);
  }
}

// Non-injecting but odd names fall back to a safe generated filename.
assert.equal(
  artifactFileNameFromUrl({ pathname: "/a/../.." }),
  `teamclaw-runtime-${process.platform}-${process.arch}.tar.gz`,
  "path-traversal file names fall back to a safe generated name",
);
// The .sha256 companion fetch reuses the SAME validated URL object.
assert.match(
  mainSource,
  /const checksumUrl = new URL\(parsedUrl\.href \+ "\.sha256"\)/,
  "the checksum fetch must be built from the validated URL (shared SSRF surface)",
);

// ---------------------------------------------------------------------------
// C2: dead RCE handlers deleted everywhere (main, preload, renderer).
// ---------------------------------------------------------------------------
for (const [label, src] of [["main", mainSource], ["preload", preloadSource], ["renderer", appJsSource]]) {
  assert.ok(!src.includes("installOpenClawLocally"), `installOpenClawLocally must be gone from ${label} (C2)`);
  assert.ok(!src.includes("installLocalTeamClaw"), `installLocalTeamClaw must be gone from ${label} (C2)`);
}
assert.ok(!preloadSource.includes("install-open-claw-locally"), "no leftover IPC channel name (C2)");

// ---------------------------------------------------------------------------
// #223 W6 follow-up: preload.mjs -> preload.cjs + sandbox:true.
// Sandboxed preloads must be CommonJS; the conversion must not change a
// single IPC channel (one-by-one parity against main.mjs's handlers).
// ---------------------------------------------------------------------------
assert.match(mainSource, /preload: path\.join\(__dirname, "preload\.cjs"\)/, "the window must load the CommonJS preload (#223 W6)");
assert.ok(!mainSource.includes('"preload.mjs"'), "no preload.mjs reference may remain in main.mjs (#223 W6)");
assert.match(mainSource, /sandbox: true/, "the renderer must run sandboxed now that the preload is CJS (#223 W6)");
assert.match(preloadSource, /const \{ contextBridge, ipcRenderer \} = require\("electron"\)/, "the preload must use CommonJS require (#223 W6)");
assert.ok(!preloadSource.includes("import "), "the sandboxed preload must not be an ES module (#223 W6)");
{
  const desktopPackageJson = JSON.parse(await fs.readFile(path.join(desktopDir, "package.json"), "utf8"));
  assert.ok(
    desktopPackageJson.build.files.includes("preload.cjs"),
    "electron-builder files list must ship preload.cjs (#223 W6)",
  );
  assert.ok(
    !desktopPackageJson.build.files.includes("preload.mjs"),
    "the stale preload.mjs entry must be gone from the packaging files list (#223 W6)",
  );
  assert.match(
    desktopPackageJson.scripts.smoke,
    /node --check preload\.cjs/,
    "the smoke script must check preload.cjs (#223 W6)",
  );
}
{
  // IPC channel parity, derived from the preload source itself: every
  // ipcRenderer.invoke channel needs its ipcMain.handle, every ipcRenderer.on
  // event needs its webContents.send. The conversion is a module-system
  // change ONLY - a renamed or dropped channel here breaks the renderer.
  const invokeChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map((m) => m[1]);
  const eventChannels = [...preloadSource.matchAll(/ipcRenderer\.on\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(invokeChannels.length >= 20, `the preload must keep its full invoke surface (found ${invokeChannels.length})`);
  for (const channel of invokeChannels) {
    assert.ok(
      new RegExp(`ipcMain\\.handle\\("${channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[,)]`).test(mainSource),
      `every preload invoke channel must keep its ipcMain.handle: ${channel}`,
    );
  }
  for (const channel of eventChannels) {
    assert.ok(
      mainSource.includes(`.send("${channel}"`),
      `every preload event channel must keep its webContents.send: ${channel}`,
    );
  }
}

// ---------------------------------------------------------------------------
// W2: CSP meta - strict for scripts (self + pinned hash, no unsafe-inline),
// open for connect (external-controller URLs are a product feature).
// ---------------------------------------------------------------------------
const cspMeta = htmlSource.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
assert.ok(cspMeta, "renderer/index.html must carry a CSP meta (W2)");
const directives = {};
for (const part of cspMeta[1].split(";")) {
  const [k, ...v] = part.trim().split(/\s+/);
  directives[k] = v.join(" ");
}
assert.match(directives["default-src"], /^'self'$/, "default-src 'self'");
assert.ok(directives["script-src"].includes("'self'"), "script-src allows local scripts");
assert.ok(!directives["script-src"].includes("'unsafe-inline'"), "script-src must NOT be unsafe-inline (W2)");
// The pinned hash must match the ACTUAL inline theme bootstrap byte-for-byte.
const inlineScript = htmlSource.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inlineScript, "the inline theme bootstrap must exist");
const inlineHash = "sha256-" + crypto.createHash("sha256").update(inlineScript[1], "utf8").digest("base64");
assert.ok(
  directives["script-src"].includes(`'${inlineHash}'`),
  `script-src must pin the real inline script hash (${inlineHash})`,
);
// External-controller connect + WebSocket are product features; images include
// remote provider avatars (https).
for (const token of ["http:", "https:", "ws:", "wss:"]) {
  assert.ok(directives["connect-src"].includes(token), `connect-src must keep ${token} (external controller feature)`);
}
assert.ok(directives["img-src"].includes("https:"), "img-src must allow remote https avatars");
assert.equal(directives["object-src"], "'none'", "object-src 'none'");

// ---------------------------------------------------------------------------
// W1: openExternal/openPath input guards.
// ---------------------------------------------------------------------------
assert.match(mainSource, /openExternal refused non-http\(s\) target/, "openExternal must whitelist http/https (W1)");
assert.match(mainSource, /openPath expects an absolute path/, "openPath must require absolute local paths (W1)");
assert.match(mainSource, /openPath expects a local path, not a URL/, "openPath must refuse URLs (W1)");
// Cross-review fix (behavioral): Windows drive-letter and UNC paths ARE
// absolute local paths - the old scheme regex misread "C:" as a URL scheme
// and broke "open project in Explorer" on Windows.
{
  const openPathRejection = evalWithDeps(extractFunction(mainSource, "openPathRejection"), { path });
  assert.equal(openPathRejection("C:\\Users\\teamclaw\\projects\\demo"), null, "drive-letter path with backslashes must open (Windows flow)");
  assert.equal(openPathRejection("D:/data/projects/demo"), null, "drive-letter path with forward slashes must open");
  assert.equal(openPathRejection("\\\\fileserver\\share\\project"), null, "UNC path must open");
  assert.equal(openPathRejection("/tmp/teamclaw/project"), null, "posix absolute path must open");
  assert.match(openPathRejection("file:///etc/passwd"), /not a URL/, "file:// URLs stay refused");
  assert.match(openPathRejection("https://evil.example/pwn"), /not a URL/, "https URLs stay refused");
  assert.match(openPathRejection("smb://server/share"), /not a URL/, "custom protocol URLs stay refused");
  assert.match(openPathRejection("projects/demo"), /absolute path/, "relative paths stay refused");
  assert.match(openPathRejection("C:relative\\path"), /not a URL/, "drive-RELATIVE (no root slash) stays refused as ambiguous");
}

// ---------------------------------------------------------------------------
// W3: gateway lifecycle.
// ---------------------------------------------------------------------------
assert.match(mainSource, /function openClawSpawnPlan\(/, "shell-free spawn plan must exist (W3)");
assert.match(mainSource, /ELECTRON_RUN_AS_NODE/, "binaries must run under Electron's embedded node");
assert.match(mainSource, /function spawnGatewayProcess\(/, "gateway spawns must funnel through one helper (W3)");
assert.match(mainSource, /function killGatewayTree\(/, "process-tree kill helper must exist (W3)");
assert.match(mainSource, /process\.kill\(-target, signal\)/, "POSIX kill must signal the process GROUP (W3)");
assert.match(mainSource, /process\.kill\(-target, "SIGKILL"\)|killGatewayTree\((?:live, target|null, pid), "SIGKILL"\)/, "SIGKILL escalation must exist (W3)");
assert.match(mainSource, /taskkill", \["\/PID", String\(target\), "\/T", "\/F"\]/, "Windows tree-kill fallback must exist (W3)");
// No gateway is spawned through a shell template string anymore.
assert.ok(!/spawn\(`"\$\{bin\}" gateway/.test(mainSource), "no shell-spawned gateway may remain (W3)");
// The ONLY remaining shell+logfd spawn shape must live INSIDE the gateway
// helper (its documented Windows .cmd fallback), not in call sites.
{
  const helperBody = extractFunction(mainSource, "spawnGatewayProcess");
  const shape = /shell: true,\n\s*stdio: \["ignore", logFd, logFd\]/;
  const outside = mainSource.split(shape).length - 1;
  const inside = helperBody.match(shape) ? 1 : 0;
  assert.ok(
    !outside || outside === inside,
    "direct log-fd shell spawns must be gone from call sites - only the gateway helper's Windows fallback may keep one (W3)",
  );
}
// before-quit is synchronous w.r.t. cached state (no settings I/O on quit).
const beforeQuitBlock = mainSource.slice(mainSource.indexOf('app.on("before-quit"'));
assert.ok(beforeQuitBlock.includes("cachedInstanceRecord"), "before-quit must read the cached instance record (W3)");
assert.ok(!/app\.on\("before-quit"[\s\S]{0,600}await loadSettings/.test(mainSource), "before-quit must not await settings I/O (W3)");
// standaloneStop escalates instead of resolving blind.
assert.match(mainSource, /killGatewayTree\(child, null, "SIGKILL"\)/, "standaloneStop must escalate to SIGKILL (W3)");
// Leaked log fd: the gateway helper closes its fd on exit.
assert.match(mainSource, /const closeLog = \(\) => \{/, "gateway log fd must be closed on child exit (Info)");

// ---------------------------------------------------------------------------
// W4: stream accounting - behavioral check on the REAL pump.
// ---------------------------------------------------------------------------
const { spawn: realSpawn } = await import("node:child_process");
const streamChildOutput = evalWithDeps(extractFunction(mainSource, "streamChildOutput"), { spawn: realSpawn });
{
  const lines = [];
  // Two writes that each carry a PARTIAL line ("split-" then "me\n"): the old
  // pump appended the pending buffer to stderr on every chunk, counting the
  // partial text twice. The fixed pump appends each chunk exactly once.
  const child = realSpawn(process.execPath, ["-e", 'console.log("out-1"); console.error("err-partial"); process.stdout.write("no-newline-tail"); console.log("out-2"); process.stderr.write("split-"); setTimeout(() => { process.stderr.write("me\\n"); console.error("err-2"); }, 60);']);
  const result = await streamChildOutput(child, "probe", (l) => lines.push(l));
  assert.equal(result.code, 0, "probe child must exit 0");
  assert.ok(result.stdout.includes("out-1") && result.stdout.includes("out-2"), `stdout must be captured (got: ${JSON.stringify(result.stdout)})`);
  assert.ok(result.stdout.includes("no-newline-tail"), "partial stdout lines must be captured too");
  assert.equal((result.stderr.match(/split-/g) || []).length, 1, `cross-chunk partial lines must be counted exactly once (got: ${JSON.stringify(result.stderr)})`);
  assert.equal(result.stderr.match(/err-partial/g).length, 1);
  assert.ok(result.stderr.includes("split-me"), "the split line must be reassembled");
  assert.ok(result.stderr.includes("err-2"), "stderr must be captured");
  assert.ok(lines.some((l) => l === "out-1") && lines.some((l) => l === "err-2"), "onLine must receive both streams");
}

// ---------------------------------------------------------------------------
// W5: navigation guards.
// ---------------------------------------------------------------------------
assert.match(mainSource, /app\.on\("web-contents-created"/, "web-contents-created guard must exist (W5)");
assert.match(mainSource, /contents\.on\("will-navigate"/, "will-navigate guard must exist (W5)");
assert.match(mainSource, /setWindowOpenHandler/, "setWindowOpenHandler must exist (W5)");
// Cross-review tightening: a bare file:// prefix would still allow navigating
// to any local file - only this renderer's OWN directory may be navigated.
assert.match(mainSource, /const RENDERER_ROOT = path\.join\(__dirname, "renderer"\) \+ path\.sep/, "will-navigate must whitelist only the renderer directory");
assert.match(mainSource, /fileURLToPath\(target\)/, "the file:// target must be compared as a platform-native path");

// ---------------------------------------------------------------------------
// #220: probe pre-resolution + explicit timeout.
// ---------------------------------------------------------------------------
assert.match(mainSource, /function resolveExecutableOnPath\(/, "PATH pre-resolution must exist (#220)");
assert.match(mainSource, /OPENCLAW_PROBE_TIMEOUT_MS = \d+/, "probe timeout constant must exist (#220)");
assert.match(mainSource, /child\.kill\("SIGKILL"\);\s*\} catch \{ \/\* already gone \*\/ \}/, "a hung probe must be hard-killed (#220)");
// Cross-review fix: a timeout kill has code null - reporting it as
// "exited with 1" was misleading; the warning must say so honestly.
assert.match(mainSource, /"no exit code"/, "a killed probe (code null) must not be reported as exit code 1 (#220)");
assert.ok(!mainSource.includes('spawn("openclaw"'), "the probe must never spawn a bare PATH-dependent name (#220)");
assert.match(mainSource, /openClawSpawnPlan\(resolved, \["--help"\]\)/, "the probe must spawn the pre-resolved absolute path (#220)");
// Behavioral: resolveExecutableOnPath actually resolves node and rejects junk.
const resolveExecutableOnPath = evalWithDeps(
  extractFunction(mainSource, "resolveExecutableOnPath"),
  { path, fsSync: await import("node:fs") },
);
{
  const nodePath = resolveExecutableOnPath("node");
  assert.ok(nodePath && path.isAbsolute(nodePath), "node must resolve to an absolute executable path");
  assert.equal(resolveExecutableOnPath("definitely-not-a-real-binary-xyz"), null, "missing executables must resolve to null (old ENOENT signal)");
}

// ---------------------------------------------------------------------------
// Smoke: every desktop JS entry parses (node --check parity via spawn).
// ---------------------------------------------------------------------------
for (const file of ["main.mjs", "preload.cjs", "runtime-extract.mjs", "renderer/app.js", "renderer/i18n.js"]) {
  const check = spawnSync(process.execPath, ["--check", path.join(desktopDir, file)], { encoding: "utf8" });
  assert.equal(check.status, 0, `node --check must pass for ${file}: ${check.stderr}`);
}

console.log("test-desktop-p0: all assertions passed (C1 fetch+validation incl. live injection payloads, #223 DNS-rebinding gate incl. real localtest.me->127.0.0.1 rejection, C2 dead RCE gone, CSP hash pinned, W1/W3/W4/W5 lifecycle+guards, #220 probe resolve+timeout)");
