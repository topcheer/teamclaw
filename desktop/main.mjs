import { app, BrowserWindow, ipcMain, nativeTheme, Notification, shell } from "electron";
import { spawn } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureBundledRuntime, makeOpenclawShim } from "./runtime-extract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// True sandbox switch for testing: on macOS Electron's userData follows the
// SYSTEM home (NSHomeDirectory), not $HOME - env-HOME sandboxes silently
// read the real user's config (that's how test instances ended up connected
// to the production controller). TC_USER_DATA redirects userData before
// anything reads it.
if (process.env.TC_USER_DATA) {
  app.setPath("userData", process.env.TC_USER_DATA);
}
const DEFAULT_SETTINGS = {
  // NO silent localhost default: an empty URL means "no instance chosen yet".
  // Boot must go through settings.instance; a hardcoded 9527 dials whatever
  // else runs on this machine (e.g. a host production controller).
  controllerUrl: "",
  theme: "system",
  // instance = the app's single source of truth for what to run/connect:
  //   mode: "private"  - bundled/sandbox runtime, own state dir, own port
  //                       lifecycle "app" (die with app) | "persistent"
  //         "global"   - the machine-level OpenClaw (system PATH binary,
  //                       default state dir). Reuses any pre-existing state
  //                       and NEVER overwrites its LLM config.
  //         "external" - just connect to a controller URL, manage nothing.
  //   controllerUrl - resolved/known URL for this instance
  //   llmConfigured - whether the wizard already wrote LLM config for it
  instance: null,
};

let mainWindow = null;

const LOCAL_SETUP_MODES = [
  {
    id: "controller-manual",
    title: "Local quickstart",
    description: "Runs the controller here with same-host process provisioning and empty preferred provisioning roles. TeamClaw can still scale up to the configured per-role cap.",
    warning: "Leanest same-host setup. TeamClaw still provisions local worker processes on demand, but keeps `workerProvisioningRoles: []` so startup readiness falls back to a warm developer worker.",
    recommended: true,
  },
  {
    id: "controller-process",
    title: "Local multi-process",
    description: "Runs the controller here and provisions local worker processes on demand.",
    warning: "Uses more CPU and memory, but gives local workers stronger process isolation.",
    recommended: false,
  },
];

function getDesktopIconPath() {
  return path.join(__dirname, "renderer", "assets", "teamclaw-app-icon.png");
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

// #223 W3: cached instance record. `before-quit` used to await loadSettings();
// async quit listeners let the app exit mid-read and orphan the gateway. The
// cache is refreshed on every settings read/write and read SYNCHRONOUSLY at
// quit time.
let cachedInstanceRecord = null;

async function loadSettings() {
  // sandbox flag is derived, never persisted: a TC_USER_DATA launch must
  // behave like a fresh machine (wizard defaults to PRIVATE, no probing of
  // the host's real openclaw/controller) even after settings get saved.
  const derived = { ...DEFAULT_SETTINGS, sandbox: Boolean(process.env.TC_USER_DATA) };
  try {
    const raw = await fs.readFile(getSettingsPath(), "utf8");
    const merged = { ...derived, ...JSON.parse(raw), sandbox: derived.sandbox };
    cachedInstanceRecord = merged.instance ?? null;
    return merged;
  } catch {
    return { ...derived };
  }
}

async function saveSettings(nextSettings) {
  const settings = { ...DEFAULT_SETTINGS, ...(nextSettings || {}) };
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
  cachedInstanceRecord = settings.instance ?? null;
  return settings;
}

function buildLocalInstallCommand(mode) {
  const selectedMode = LOCAL_SETUP_MODES.some((entry) => entry.id === mode) ? mode : "controller-manual";
  return `npx -y @teamclaws/teamclaw install --yes --install-mode ${selectedMode}`;
}

// Probe result:
//   { installed: true,  warning: null }        - `openclaw --help` exited 0
//   { installed: true,  warning: "<details>" } - binary resolved and ran but --help kept
//       failing after one retry (e.g. transient failure while the gateway is busy
//       provisioning workers). Treated as installed-with-warning instead of
//       not-installed so the "reusing" short-circuit never silently degrades into a
//       full runtime install attempt (#140).
//   { installed: false, warning: null }        - binary does not resolve (spawn ENOENT):
//       genuinely not installed; no retry is spent on this case.
const OPENCLAW_PROBE_RETRY_DELAY_MS = 250;
// #220: a hung `openclaw --help` used to block the wizard forever - the probe
// now hard-kills after this timeout and reports via the warning path.
const OPENCLAW_PROBE_TIMEOUT_MS = 10000;

// #220: resolve `openclaw` to an ABSOLUTE executable path before spawning.
// A bare name relies on the ambient PATH at spawn time; an explicit path
// removes that dependency and makes the timeout kill the right process (no
// shell wrapper to lose track of). Returns null when nothing executable sits
// on PATH - the same signal the old ENOENT outcome carried (not installed).
function resolveExecutableOnPath(name) {
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, process.platform === "win32" ? name + ext : name);
      try {
        const st = fsSync.statSync(candidate);
        if (!st.isFile()) continue;
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        return candidate;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

// Cached PATH resolution (PATH does not change while the app runs).
let OPENCLAW_PATH_CACHE;
function resolvedOpenClawBinary() {
  if (OPENCLAW_PATH_CACHE === undefined) {
    OPENCLAW_PATH_CACHE = resolveExecutableOnPath("openclaw");
  }
  return OPENCLAW_PATH_CACHE;
}

// Map an openclaw bin reference to a spawnable { command, args, env } plan
// WITHOUT a shell (#223 W3 - see the gateway lifecycle block below for why
// every gateway spawn goes through this).
function openClawSpawnPlan(bin, args) {
  if (!bin) return null;
  // Node-script entries run under Electron's embedded node - the launcher
  // shim's trick without the wrapper script (and without needing system Node,
  // the shim shebang does `#!/usr/bin/env node`).
  if (/\.(mjs|cjs|js)$/i.test(bin)) {
    return { command: process.execPath, args: [bin, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  // Bin shims (npm .bin/<name>, the extracted-runtime launcher shim, global
  // <prefix> layouts) all sit next to the real package entry at a
  // deterministic path - prefer the entry over the shim.
  const entryCandidates = [];
  if (bin === EXTRACTED_OPENCLAW_SHIM && EXTRACTED_RUNTIME_DIR) {
    entryCandidates.push(path.join(EXTRACTED_RUNTIME_DIR, "node_modules", "openclaw", "openclaw.mjs"));
  }
  const binDir = path.dirname(bin);
  entryCandidates.push(path.join(binDir, "..", "openclaw", "openclaw.mjs")); // <tree>/node_modules/.bin/<name>
  entryCandidates.push(path.join(binDir, "..", "lib", "node_modules", "openclaw", "openclaw.mjs")); // <prefix>/bin + posix npm global
  entryCandidates.push(path.join(binDir, "node_modules", "openclaw", "openclaw.mjs")); // windows npm global <prefix>/<name>.cmd
  for (const entry of entryCandidates) {
    if (entry && fsSync.existsSync(entry)) {
      return { command: process.execPath, args: [entry, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
  }
  // Real executables / shebang scripts (POSIX): direct spawn.
  if (process.platform !== "win32") {
    return { command: bin, args, env: {} };
  }
  // Windows: ANY bin form with no discoverable package entry (.cmd, .bat,
  // bare .exe wrappers, ...): shell fallback. Lifecycle is still contained -
  // stop paths escalate to `taskkill /T` which reaps the whole tree (see
  // killGatewayTree).
  return null;
}

async function probeOpenClawInstall() {
  const resolved = resolvedOpenClawBinary();
  if (!resolved) {
    return { installed: false, warning: null };
  }
  let lastFailure = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, OPENCLAW_PROBE_RETRY_DELAY_MS));
    }
    const outcome = await new Promise((resolve) => {
      // #220: spawn the RESOLVED absolute path (no PATH lookup, no shell
      // wrapper) and bound the probe - a wedged --help gets SIGKILLed.
      const plan = openClawSpawnPlan(resolved, ["--help"]);
      const child = plan
        ? spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true, env: { ...process.env, ...plan.env } })
        : spawn(`"${resolved}" --help`, { stdio: "ignore", windowsHide: true, shell: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, OPENCLAW_PROBE_TIMEOUT_MS);
      child.on("error", (error) => { clearTimeout(timer); resolve({ kind: "error", error }); });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve(timedOut ? { kind: "exit", code: null, signal: "SIGKILL", timeout: true } : { kind: "exit", code, signal });
      });
    });
    if (outcome.kind === "exit" && outcome.code === 0) {
      return { installed: true, warning: null };
    }
    // The resolved binary vanished between resolve and spawn: genuinely gone.
    if (outcome.kind === "error" && outcome.error && outcome.error.code === "ENOENT") {
      OPENCLAW_PATH_CACHE = null;
      return { installed: false, warning: null };
    }
    lastFailure = outcome;
  }
  if (lastFailure.kind === "exit") {
    // Cross-review fix: a timeout kill has code=null and writing "exited
    // with 1" was misleading - surface the real signal/timeout instead.
    const codeText = lastFailure.code !== null && lastFailure.code !== undefined
      ? String(lastFailure.code)
      : "no exit code";
    return {
      installed: true,
      warning: `openclaw --help exited with ${codeText}` +
        (lastFailure.signal ? ` (signal ${lastFailure.signal})` : "") +
        (lastFailure.timeout ? " (probe timeout)" : "") +
        " after retry",
    };
  }
  return {
    installed: true,
    warning: `openclaw --help probe failed after retry: ${lastFailure.error && lastFailure.error.message ? lastFailure.error.message : "unknown error"}`,
  };
}

async function hasOpenClawInstalled() {
  const probe = await probeOpenClawInstall();
  return probe.installed;
}

async function getLocalSetupInfo() {
  const probe = await probeOpenClawInstall();
  return {
    hasOpenClaw: probe.installed,
    openClawInstallCommand: "sandboxed: desktop-managed runtime (never global)",
    openClawQuickstartCommand: "openclaw onboard --flow quickstart --install-daemon",
    openClawProbeWarning: probe.warning,
    modes: LOCAL_SETUP_MODES.map((entry) => ({
      ...entry,
      installCommand: buildLocalInstallCommand(entry.id),
    })),
  };
}

async function runShellCommand(command, options = {}) {
  const cwd = String(options.cwd || "").trim() || process.cwd();
  const child = spawn(command, {
    cwd,
    env: options.env || process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk || "");
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk || "");
  });

  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const result = {
        ok: code === 0,
        code: code ?? null,
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command,
        cwd,
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const failure = new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`);
      Object.assign(failure, result);
      reject(failure);
    });
  });
}

/* ---------------- Artifact download (#223 C1) ----------------
 * The renderer-supplied artifactUrl used to be interpolated into a shell
 * curl command - a quote in the URL was arbitrary command execution in the
 * main process. The download now runs through Node fetch with a validated
 * URL: no shell anywhere in the path, and the SAME validated URL feeds the
 * "<url>.sha256" companion fetch (shared, bounded SSRF surface).
 */
/* Host hygiene shared by the TEXTUAL validator below and the post-DNS
 * re-check (DNS rebinding follow-up, Refs #223): one normalization + one
 * blocklist for literal hostnames AND for dns.lookup results, so the two
 * paths can never drift apart.
 */
function artifactEffectiveHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  // Unwrap IPv4-mapped / IPv4-compatible IPv6 BEFORE the blocklist: the URL
  // parser normalizes [::ffff:127.0.0.1] to the hex form [::ffff:7f00:1],
  // which slips past every textual rule below (cross-review finding).
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  const mappedHex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedDotted) {
    return mappedDotted[1];
  }
  if (mappedHex) {
    // ::ffff:7f00:1 (mapped) or ::7f00:1 (compatible) -> dotted quad
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  // NAT64 unwrap (#246): the well-known prefix 64:ff9b::/96 embeds the real
  // IPv4 destination in the low 32 bits. A DNS64/NAT64 network hands out e.g.
  // 64:ff9b::a00:1, which no v6 rule below flags, while the NAT64 gateway
  // dials the embedded 10.0.0.1 straight into the intranet. Extract the
  // embedded v4 so the SAME v4 blocklist judges the actual target (a public
  // embedded v4 stays allowed - NAT64 to the internet is legitimate).
  const nat64 = nat64EmbeddedIpv4(host);
  if (nat64) {
    return nat64;
  }
  return host;
}

// #246: parse a textual IPv6 literal (hex groups, at most one "::"; dotted
// tails were already unwrapped above) and return the embedded IPv4 dotted
// quad when the address sits inside the well-known NAT64 prefix 64:ff9b::/96
// (first 96 bits exactly 0064:ff9b:...:0000), else null. Pure and shared by
// the textual validator and the post-DNS re-check via artifactEffectiveHost.
function nat64EmbeddedIpv4(host) {
  if (!host.startsWith("64:ff9b")) return null; // fast reject: hostnames, other literals
  if (!/^[0-9a-f:]+$/.test(host)) return null; // dotted tails / zone ids / junk
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const groups = (half) =>
    half === "" ? [] : half.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : null;
  if (head.some((g) => Number.isNaN(g)) || (tail && tail.some((g) => Number.isNaN(g)))) return null;
  let all;
  if (tail) {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null; // "::" must stand in for at least one zero group
    all = [...head, ...new Array(zeros).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null; // no "::": must be exactly 8 groups
    all = head;
  }
  if (all[0] !== 0x64 || all[1] !== 0xff9b || all.slice(2, 6).some((g) => g !== 0)) return null;
  const hi = all[6];
  const lo = all[7];
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}
function isBlockedArtifactHost(effectiveHost) {
  // "localhost" / cloud metadata names / loopback / RFC1918 / link-local
  // v4+v6 / "this network" - the same list the literal check has always used.
  return effectiveHost === "localhost" ||
    effectiveHost === "metadata.google.internal" ||
    effectiveHost === "::1" ||
    /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(effectiveHost) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(effectiveHost) ||
    /^(f[cd]|fe[89ab])/i.test(effectiveHost); // fc00::/7 (private v6), fe80::/10 (link-local v6)
}
// Literal IPv4 (dotted quad, incl. v4-mapped IPv6 after the unwrap above) or
// any IPv6 literal (contains ":"): already judged character-for-character by
// the blocklist - running it through DNS again would be a no-op.
function isLiteralIpHost(effectiveHost) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(effectiveHost) || effectiveHost.includes(":");
}

function validateArtifactUrl(raw) {
  const rawUrl = String(raw || "");
  // Reject dangerous characters on the RAW input first: the URL parser
  // percent-encodes quotes/spaces into the pathname (%22/%20), so checking
  // only the parsed form would let the original metachars through.
  if (/[\u0000-\u0020"'`$()<>\\]/.test(rawUrl)) {
    throw new Error("Runtime artifact URL contains disallowed characters.");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid runtime artifact URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Runtime artifact URL must be https (got ${parsed.protocol || "none"}).`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Runtime artifact URL must not embed credentials.");
  }
  // The URL originates in the renderer: refuse obvious intranet / cloud
  // metadata / loopback targets (plain-http metadata endpoints are already
  // unreachable via the https-only rule above).
  const effectiveHost = artifactEffectiveHost(parsed.hostname);
  if (isBlockedArtifactHost(effectiveHost)) {
    throw new Error(`Runtime artifact host not allowed: ${parsed.hostname}`);
  }
  if (/%22|%27|%60|%5[cC]|%3[cC]|%3[eE]/i.test(parsed.pathname + parsed.search)) {
    throw new Error("Runtime artifact URL contains disallowed characters.");
  }
  return parsed;
}

/* DNS-rebinding gate (#223 review follow-up): validateArtifactUrl only ever
 * saw the hostname STRING - a public DNS name that resolves straight into the
 * intranet (https://localtest.me -> 127.0.0.1) passed validation untouched.
 * After the textual checks pass, resolve the hostname with
 * dns.lookup(hostname, { all: true }) and run the SAME blocklist over every
 * resolved address: any private/loopback/link-local/metadata hit rejects.
 * Literal IP hosts never reach here in practice (callers skip them), but the
 * check is idempotent for them anyway.
 *
 * TOCTOU declaration: this resolves, then fetch resolves again - a rebinding
 * attacker controlling a short-TTL record could in theory answer the second
 * lookup with an intranet IP (check-then-use gap). The complete fix is a
 * custom undici Agent with a connect-time lookup (fetch "dispatcher" option)
 * that pins or re-refuses the address at connect - but building an Agent
 * requires importing the undici npm package (Node's bundled copy is not
 * importable, and desktop/package.json deliberately ships zero runtime deps),
 * i.e. a new supply-chain dependency for the packaged app. Declared residual
 * window instead: this gate runs in the SAME loop iteration as the fetch it
 * guards (validatedArtifactFetch, every hop), and both this lookup and
 * undici's connect go through getaddrinfo - the fetch's answer normally comes
 * from the same OS resolver cache (mDNSResponder / systemd-resolved) within
 * the record's TTL, so the attacker must win a race against that cache, not
 * merely flip a DNS record.
 *
 * Failure semantics are FAIL-CLOSED: an unresolvable name, an empty answer,
 * or a resolver that does not answer within ARTIFACT_DNS_TIMEOUT_MS refuses
 * the download (a hostile or broken resolver is indistinguishable). The one
 * extra DNS roundtrip per download (cached by the OS resolver between the
 * gate and the fetch) is an acceptable cost for closing the rebinding hole.
 */
const ARTIFACT_DNS_TIMEOUT_MS = 2500;
async function assertArtifactHostResolvesPublic(parsedUrl) {
  const effectiveHost = artifactEffectiveHost(parsedUrl.hostname);
  if (isLiteralIpHost(effectiveHost)) return; // literal IPs were judged directly - no DNS hop
  let addresses;
  try {
    const lookup = dns.lookup(effectiveHost, { all: true });
    // Silence the race loser: a slow/hung lookup rejecting after the timeout
    // already failed us must not surface as an unhandled rejection (fatal).
    lookup.catch(() => {});
    let timer = null;
    addresses = await Promise.race([
      lookup,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${ARTIFACT_DNS_TIMEOUT_MS}ms`)), ARTIFACT_DNS_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  } catch (e) {
    throw new Error(`Runtime artifact host '${parsedUrl.hostname}' could not be resolved (fail-closed): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`Runtime artifact host '${parsedUrl.hostname}' resolved to no addresses (fail-closed).`);
  }
  for (const { address } of addresses) {
    if (isBlockedArtifactHost(artifactEffectiveHost(address))) {
      throw new Error(`Runtime artifact host not allowed: ${parsedUrl.hostname} resolves to blocked address ${address}`);
    }
  }
}

// The derived file name lands on disk inside userData/downloads: charset-
// whitelist it so it can never escape the dir or surprise the filesystem.
function artifactFileNameFromUrl(parsedUrl) {
  const rawName = path.posix.basename(parsedUrl.pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rawName) || rawName === "." || rawName === "..") {
    return `teamclaw-runtime-${process.platform}-${process.arch}.tar.gz`;
  }
  return rawName;
}

// curl-equivalent download semantics: follow redirects, fail on HTTP error,
// retry transient failures (--retry 3), stream progress lines to the wizard
// log (curl's stderr meter used to provide those). No shell, no injection.
//
// Proxy/CA note (cross-review declaration): unlike curl, this fetch path
// does NOT read HTTP(S)_PROXY env by default (Node fetch needs
// NODE_USE_ENV_PROXY=1) and custom CAs need NODE_EXTRA_CA_CERTS instead of
// CURL_CA_BUNDLE - a behavior change for corporate-proxy environments.
const ARTIFACT_DOWNLOAD_ATTEMPTS = 3;
const ARTIFACT_MAX_REDIRECTS = 5;

// Follow redirects MANUALLY, re-validating EVERY hop through
// validateArtifactUrl: with redirect:"follow" a public https URL could 302
// to http://127.0.0.1 and fetch would happily read the intranet response
// body (cross-review finding - verified with a live 302 server). Every hop
// (including the first) ALSO passes the DNS rebinding gate, immediately
// before the fetch it guards - same loop iteration, minimal check-to-use
// gap, and the ".sha256" companion fetch shares this whole path.
async function validatedArtifactFetch(parsedUrl) {
  let current = parsedUrl;
  for (let hop = 0; hop <= ARTIFACT_MAX_REDIRECTS; hop++) {
    await assertArtifactHostResolvesPublic(current);
    const res = await fetch(current.href, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(`redirect without Location header from ${current.host}`);
      }
      // Same validator, same rules - scheme/host/metachars, every hop.
      current = validateArtifactUrl(new URL(location, current.href).href);
      continue;
    }
    return res;
  }
  throw new Error(`too many redirects (more than ${ARTIFACT_MAX_REDIRECTS})`);
}
async function downloadArtifact(parsedUrl, dest, onLine) {
  let lastError = null;
  for (let attempt = 1; attempt <= ARTIFACT_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadArtifactOnce(parsedUrl, dest, onLine, attempt);
    } catch (e) {
      lastError = e;
      await fs.rm(dest, { force: true }).catch(() => {});
      if (attempt < ARTIFACT_DOWNLOAD_ATTEMPTS) {
        onLine(`Download failed (${e instanceof Error ? e.message : String(e)}) - retrying (${attempt}/${ARTIFACT_DOWNLOAD_ATTEMPTS - 1})...`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastError;
}

async function downloadArtifactOnce(parsedUrl, dest, onLine, attempt) {
  const res = await validatedArtifactFetch(parsedUrl);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}${res.statusText ? " " + res.statusText : ""} from ${parsedUrl.host}`);
  }
  const total = Number(res.headers.get("content-length")) || null;
  onLine(`Downloading runtime artifact from ${parsedUrl.host} (attempt ${attempt}/${ARTIFACT_DOWNLOAD_ATTEMPTS})${total ? ` - ${(total / 1048576).toFixed(1)} MB` : ""}...`);
  const handle = await fs.open(dest, "w");
  let received = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk);
      received += chunk.length;
      if (received - lastReport >= 4 * 1048576 || (total && received >= total)) {
        lastReport = received;
        onLine(`Downloaded ${(received / 1048576).toFixed(1)} MB${total ? ` of ${(total / 1048576).toFixed(1)} MB` : ""}`);
      }
    }
  } finally {
    await handle.close();
  }
  return { bytes: received };
}

// sha256 of a local file via node:crypto - replaces the `shasum` shell call
// (which does not exist on Windows either; same for the removed curl).
async function sha256File(file) {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(512 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

// tar as a real binary with an argv array: no shell, no quoting. Windows
// ships bsdtar in System32 (Win10+); runtime-extract.mjs uses the same rule.
function tarBinary() {
  if (process.platform === "win32") {
    const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fsSync.existsSync(sysTar)) return sysTar;
  }
  return "tar";
}

/* ---------------- Bootstrap installer (streamed) ---------------- */

// Install sources for the OpenClaw + TeamClaw runtimes.
//   bundled  - ships inside this app (extraResources/bin; offline install)
//   official - npm registry (@latest)
//   artifact - prebuilt tar from the FIXED-URL GitHub release (runtime-latest)
const BUNDLED_BIN_DIR = () => path.join(process.resourcesPath || "", "bin");

// Compressed-form runtime (installers ship resources/bin/runtime.tgz; the
// unpacked 1GB tree is history). Extracted to userData/bundled/runtime on
// first use - see runtime-extract.mjs. Null until warmed / not bundled.
let EXTRACTED_RUNTIME_DIR = null;
let EXTRACTED_OPENCLAW_SHIM = null;
async function warmBundledRuntime(onEvent) {
  if (EXTRACTED_RUNTIME_DIR) return EXTRACTED_RUNTIME_DIR;
  try {
    EXTRACTED_RUNTIME_DIR = await ensureBundledRuntime({
      resourcesBinDir: BUNDLED_BIN_DIR(),
      userDataDir: app.getPath("userData"),
      onEvent,
    });
    // Launcher shim: the entry is openclaw.mjs (a Node script). Windows has
    // no .mjs association - shell-spawning it pops "choose an app". The shim
    // runs it under Electron's embedded Node, no system Node needed.
    if (EXTRACTED_RUNTIME_DIR) {
      EXTRACTED_OPENCLAW_SHIM = makeOpenclawShim(EXTRACTED_RUNTIME_DIR, process.execPath);
    }
  } catch (e) {
    if (onEvent) onEvent({ phase: "runtime", line: "Bundled runtime extraction failed: " + (e && e.message) });
  }
  return EXTRACTED_RUNTIME_DIR;
}
function bundledRuntimeRoot() {
  // Extracted dir (userData) wins; unpacked resources/bin/runtime remains
  // for dev runs and legacy builds.
  if (EXTRACTED_RUNTIME_DIR) return EXTRACTED_RUNTIME_DIR;
  return path.join(BUNDLED_BIN_DIR(), "runtime");
}

function bundledBinary(name) {
  // extraResources embeds build/bundle -> Resources/bin. NOTE: the .bin
  // entries are SYMLINKS and electron-builder's copy breaks them (lstat
  // hits, existsSync false), so resolve the REAL files instead:
  //   openclaw  -> node_modules/openclaw/openclaw.mjs
  //   (any pkg) -> node_modules/<name>/... resolved per-package below
  if (name === "openclaw") {
    // Extracted (compressed-form) runtime: return the LAUNCHER SHIM, never
    // the bare .mjs - Windows cannot shell-execute .mjs (no association).
    if (EXTRACTED_OPENCLAW_SHIM && fsSync.existsSync(EXTRACTED_OPENCLAW_SHIM)) {
      return EXTRACTED_OPENCLAW_SHIM;
    }
    const real = path.join(bundledRuntimeRoot(), "node_modules", "openclaw", "openclaw.mjs");
    return fsSync.existsSync(real) ? real : null;
  }
  const direct = path.join(BUNDLED_BIN_DIR(), name);
  if (fsSync.existsSync(direct)) return direct;
  const tree = path.join(bundledRuntimeRoot(), "node_modules", ".bin", name);
  return fsSync.existsSync(tree) ? tree : null;
}

function resolveInstallSource(source) {
  switch (source) {
    case "bundled":
    case "official":
    case "artifact":
      return source;
    default:
      // Auto: prefer a bundled binary when present, else npm.
      return bundledBinary("openclaw") ? "bundled" : "official";
  }
}

async function ensureOpenClawRuntime({ source, artifactUrl }, onEvent) {
  // Returns the openclaw command (bundled path or global CLI name).
  // Bundled tree WINS over reusing the global install: the embedded runtime
  // keeps openclaw+teamclaw peers resolvable inside one tree, which is what
  // makes fully-offline plugin registration work (a local-path plugins
  // install otherwise resolves its openclaw peer over npm).
  const bundledPre = bundledBinary("openclaw");
  if (!bundledPre) {
    // Cold start before the whenReady warm-up finished - extract on demand.
    await warmBundledRuntime(onEvent);
  }
  const bundled = bundledBinary("openclaw");
  if (bundled) {
    onEvent({ phase: "openclaw", line: "Using bundled OpenClaw runtime: " + bundled });
    return bundled;
  }
  const existing = await hasOpenClawInstalled();
  if (existing) {
    onEvent({ phase: "openclaw", line: "OpenClaw already installed - reusing." });
    return "openclaw";
  }
  const src = resolveInstallSource(source);
  if (src === "bundled") {
    const bin = bundledBinary("openclaw");
    if (!bin) throw new Error("Bundled OpenClaw binary missing from the app package.");
    onEvent({ phase: "openclaw", line: "Using bundled OpenClaw binary: " + bin });
    return bin;
  }
  if (src === "artifact") {
    // Fixed-URL rolling release (user design): tag never moves, CI replaces
    // assets. Default URL, user-overridable; sha256 verified when available.
    // #223 C1: validated Node fetch download (no shell curl - a crafted URL
    // was command injection), node:crypto checksum, argv-array tar.
    const plat = `${process.platform}-${process.arch}`;
    const parsedUrl = validateArtifactUrl(artifactUrl || `https://github.com/topcheer/teamclaw/releases/download/runtime-latest/teamclaw-runtime-${plat}.tar.gz`);
    const workDir = path.join(app.getPath("userData"), "downloads");
    await fs.mkdir(workDir, { recursive: true });
    const fileName = artifactFileNameFromUrl(parsedUrl);
    const dest = path.join(workDir, fileName);
    onEvent({ phase: "openclaw", line: `Downloading runtime artifact ${fileName}...` });
    await downloadArtifact(parsedUrl, dest, (line) => onEvent({ phase: "openclaw", line }));
    onEvent({ phase: "openclaw", line: "Verifying sha256..." });
    const digest = await sha256File(dest);
    try {
      // Same validated URL (SSRF surface is shared with the artifact fetch),
      // and the checksum fetch re-validates every redirect hop too.
      const checksumUrl = new URL(parsedUrl.href + ".sha256");
      const checksumRes = await validatedArtifactFetch(checksumUrl);
      const expect = ((await checksumRes.text()) || "").split(" ")[0].trim();
      if (expect && digest !== expect) throw new Error(`sha256 mismatch: ${digest} != ${expect}`);
      onEvent({ phase: "openclaw", line: "sha256 OK: " + digest.slice(0, 12) });
    } catch (e) {
      if (String(e.message || "").startsWith("sha256 mismatch")) throw e;
      onEvent({ phase: "openclaw", line: "checksum file unavailable - continuing without verification" });
    }
    const extractDir = path.join(workDir, "runtime-extracted");
    await fs.mkdir(extractDir, { recursive: true });
    await runSpawnStream(tarBinary(), ["xzf", dest, "-C", extractDir], extractDir, (line) =>
      onEvent({ phase: "openclaw", line }),
    );
    const bin = path.join(extractDir, "runtime", "node_modules", ".bin", "openclaw");
    if (!fsSync.existsSync(bin)) throw new Error("Runtime tree malformed (no openclaw bin).");
    onEvent({ phase: "openclaw", line: "Artifact runtime ready: " + bin });
    return bin;
  }
  // official: npm install into the DESKTOP-OWNED prefix - the user's global
  // installation is never touched (hard requirement from the user).
  const runtimeDir = path.join(app.getPath("userData"), "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  onEvent({ phase: "openclaw", line: `Installing OpenClaw into desktop runtime (${runtimeDir})...` });
  await runShellStream(`npm install --prefix "${runtimeDir}" openclaw@latest`, runtimeDir, (line) =>
    onEvent({ phase: "openclaw", line }),
  );
  const bin = path.join(runtimeDir, "node_modules", ".bin", "openclaw");
  if (!fsSync.existsSync(bin)) throw new Error("OpenClaw install finished but binary not found at " + bin);
  return bin;
}

async function ensureTeamClawPlugin(openclawBin, onEvent) {
  // FULLY SANDBOXED (user vetoed global writes): registration and runtime
  // both use the desktop state dir; ~/.openclaw is never written. The user's
  // global config is only ever READ (LLM seeding happens elsewhere).
  const sandboxEnv = { ...process.env, OPENCLAW_STATE_DIR: path.join(app.getPath("userData"), "openclaw-state") };
  const runtimeDir = path.join(app.getPath("userData"), "runtime");
  // The "reusing existing OpenClaw" path skips the runtime install, so the
  // runtime dir may not exist yet - spawn cwd must exist or every command
  // below fails with ENOENT.
  await fs.mkdir(runtimeDir, { recursive: true });
  const pluginDir = path.join(runtimeDir, "node_modules", "@teamclaws", "teamclaw");
  const res = await runShellCommand(`"${openclawBin}" plugins list 2>/dev/null || true`, { cwd: runtimeDir, env: sandboxEnv });
  // Precise: match the plugins-list TABLE row (│ TeamClaw │), not any
  // teamclaw substring - the stock-extensions path line also contains it.
  if (/│\s*TeamClaw\s*│/.test(res.stdout || "")) {
    onEvent({ phase: "teamclaw", line: "TeamClaw plugin already installed." });
    return;
  }
  // Fully-offline registration when a bundled tree exists: install the
  // plugin from the EMBEDDED runtime tree (same tar shape) - no npm, no
  // network. Only falls back to npm when the bundle is absent.
  const bundledOpenclaw = bundledBinary("openclaw");
  const bundledPlugin = bundledOpenclaw
    ? path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules", "@teamclaws", "teamclaw")
    : null;
  if (bundledPlugin && fsSync.existsSync(bundledPlugin)) {
    onEvent({ phase: "teamclaw", line: "Registering the bundled TeamClaw plugin (offline)..." });
    await runShellStream(`"${openclawBin}" plugins install "file:${bundledPlugin}" --force --accept-capabilities`, runtimeDir, (line) =>
      onEvent({ phase: "teamclaw", line }), sandboxEnv);
    // #147: openclaw's dependency probe enforces the plugin rootDir BOUNDARY -
    // hoisted deps (npm layout in the runtime tree) resolve OUTSIDE it and
    // the plugin lands error-state "required dependencies are missing".
    // Seal the runtime tree's node_modules INTO the installed plugin dir
    // (pure file copy, zero network). Symlinks copied verbatim; the .bin
    // entries in the plugin subtree were already materialized at bundle time.
    const extRoot = path.join(sandboxEnv.OPENCLAW_STATE_DIR, "extensions", "teamclaw");
    const extDeps = path.join(extRoot, "node_modules");
    if (fsSync.existsSync(extRoot)) {
      // Precise seal: the plugin's own declared dependencies only (5 pkgs,
      // incl. the openclaw peer) - copied one-by-one from the bundled tree so
      // a single bad entry can never abort the whole copy (#147: whole-tree
      // cp died silently after ~10 entries; the boundary probe needs deps
      // INSIDE the plugin rootDir, hoisted layout does not satisfy it).
      // Seal ALL real package dirs from the bundled tree (not just direct
      // deps): the plugin loads its transitive dependencies at runtime
      // (fast-deep-equal etc.) and openclaw refuses the load on ANY missing
      // one. Per-package try/catch: a single dangling entry must not abort
      // the rest (whole-tree cp died that way).
      const runtimeNM = path.join(BUNDLED_BIN_DIR(), "runtime", "node_modules");
      let sealed = 0, skipped = 0;
      const sealDir = async (dir) => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (entry.name === ".bin" || entry.name === ".package-lock.json") continue;
          const src = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name.startsWith("@")) { await sealDir(src); continue; }
          if (!entry.isDirectory()) continue;
          const hasManifest = fsSync.existsSync(path.join(src, "package.json"));
          if (!hasManifest) continue;
          const dst = path.join(extDeps, path.relative(runtimeNM, src));
          if (fsSync.existsSync(dst)) { continue; }
          await fs.cp(src, dst, { recursive: true, verbatimSymlinks: true, force: true }).then(() => { sealed++; }, () => { skipped++; });
        }
      };
      onEvent({ phase: "teamclaw", line: "Sealing offline deps (full closure) into the plugin dir..." });
      await sealDir(runtimeNM);
      onEvent({ phase: "teamclaw", line: `Deps sealed: ${sealed} packages (${skipped} skipped).` });
    }
    return;
  }
  await runShellStream(`npm install --prefix "${runtimeDir}" @teamclaws/teamclaw@latest`, runtimeDir, (line) =>
    onEvent({ phase: "teamclaw", line }),
  );
  onEvent({ phase: "teamclaw", line: "Registering the TeamClaw plugin..." });
  // npm spec install ships compiled dist (local-path installs trip the
  // "compiled runtime output" packaging check); force skips the local-path
  // trust prompt. Registration lands in the SANDBOX state dir only.
  await runShellStream(`"${openclawBin}" plugins install @teamclaws/teamclaw --force --accept-capabilities`, runtimeDir, (line) => {
    onEvent({ phase: "teamclaw", line });
  }, sandboxEnv);
}

// Minimal LLM config: write the DESKTOP-SANDBOX openclaw.json directly
// (userData/openclaw-state). The user's own ~/.openclaw is never touched -
// hard requirement. Provider + endpoint + apiKey + model, all else defaults.
// Model lands on agents.defaults.model as "<provider>/<modelId>" (canonical
// agent-model selection shape, see openclaw/src/config/model-input.ts).
async function writeLlmConfig(_openclawBin, { provider, endpoint, apiKey, model }, onEvent) {
  if (!provider || !apiKey) {
    onEvent({ phase: "llm", line: "No LLM credentials provided - keeping defaults." });
    return;
  }
  const stateDir = path.join(app.getPath("userData"), "openclaw-state");
  await fs.mkdir(stateDir, { recursive: true });
  await writeLlmConfigFile(path.join(stateDir, "openclaw.json"), { provider, endpoint, apiKey, model });
  onEvent({ phase: "llm", line: `LLM config written for ${provider}${model ? ` (${model})` : ""} (sandbox only).` });
}

// Shared writer: merges provider creds + default model into an openclaw
// config file without disturbing unrelated keys.
async function writeLlmConfigFile(cfgPath, { provider, endpoint, apiKey, model }) {
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")); } catch { cfg = {}; }
  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};
  cfg.models.providers[provider] = {
    ...(cfg.models.providers[provider] || {}),
    apiKey,
    ...(endpoint ? { baseUrl: endpoint } : {}),
  };
  if (model) {
    cfg.agents = cfg.agents || {};
    cfg.agents.defaults = { ...(cfg.agents.defaults || {}) };
    // Model refs may already be vendor-prefixed (e.g. openrouter/free) -
    // never double-prefix with the provider id.
    const modelRef = String(model).trim();
    cfg.agents.defaults.model = modelRef.startsWith(`${provider}/`) ? modelRef : `${provider}/${modelRef}`;
  }
  await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// Model discovery for the wizard: fetch the provider's model list from
// MAIN process (renderer fetch is CORS-blocked by most provider APIs).
// Returns { models: [id...] } or { error } - the renderer keeps manual
// input as fallback either way.
const PROVIDER_MODEL_SOURCES = {
  openrouter: { url: "https://openrouter.ai/api/v1/models", auth: "none" },
  openai: { url: "https://api.openai.com/v1/models", auth: "bearer" },
  anthropic: { url: "https://api.anthropic.com/v1/models", auth: "anthropic" },
  deepseek: { url: "https://api.deepseek.com/models", auth: "bearer" },
  google: { url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "query" },
  zai: { url: "https://api.z.ai/api/paas/v4/models", auth: "bearer" },
};
async function fetchProviderModels(provider, endpoint, apiKey) {
  const src = PROVIDER_MODEL_SOURCES[provider];
  if (!src) return { models: [] };
  const https = await import("node:https");
  const target = endpoint && endpoint.trim() ? endpoint.trim().replace(/\/$/, "") + "/models" : src.url;
  const headers = { Accept: "application/json" };
  if (src.auth === "bearer" || src.auth === "anthropic") headers.Authorization = `Bearer ${apiKey}`;
  if (src.auth === "anthropic") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; delete headers.Authorization; }
  const url = new URL(target);
  if (src.auth === "query") url.searchParams.set("key", apiKey);
  const body = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", reject);
  });
  if (body.status !== 200) return { error: `HTTP ${body.status}` };
  let ids = [];
  try {
    const json = JSON.parse(body.data);
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    ids = list.map((m) => (typeof m === "string" ? m : m.id || m.name || "")).filter(Boolean).map((id) => String(id).replace(/^models\//, ""));
  } catch (e) { return { error: "bad payload" }; }
  // No 200-cap here: OpenRouter alone ships 460+ models and the aggregate
  // entries (openrouter/free, openrouter/auto) sort past the first 200 -
  // the old cap silently hid them from the picker (user-found).
  return { models: ids.slice(0, 500) };
}
ipcMain.handle("llm:list-models", async (_e, { provider, endpoint, apiKey }) => {
  try { return await fetchProviderModels(provider, endpoint, apiKey); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
});

// Global-mode LLM write (user explicitly chose "configure" over "use
// existing"): writes the machine-level ~/.openclaw/openclaw.json. Only the
// chosen provider entry + agents.defaults.model are merged in.
ipcMain.handle("llm:write-global", async (_e, llm) => {
  const { provider, endpoint, apiKey, model } = llm || {};
  if (!provider || !apiKey) throw new Error("Provider and API key are required");
  // os.homedir(): process.env.HOME is empty on Windows, which silently
  // redirected the wizard's LLM write to a relative path inside the app
  // install dir instead of the user's ~/.openclaw.
  const globalCfg = path.join(os.homedir(), ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(globalCfg), { recursive: true });
  await writeLlmConfigFile(globalCfg, { provider, endpoint, apiKey, model });
  return { ok: true, path: globalCfg };
});

// Streamed variant: emits every stdout/stderr line through onLine and
// resolves with the same result shape as runShellCommand.
async function runShellStream(command, cwd, onLine, envOverride) {
  const child = spawn(command, {
    cwd,
    env: envOverride || process.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return await streamChildOutput(child, command, onLine);
}

// Argv-array variant (#223): no shell, no string splicing - for steps where
// the binary and args are fully app-owned (tar extraction, ...).
async function runSpawnStream(command, args, cwd, onLine, envOverride) {
  const child = spawn(command, args, {
    cwd,
    env: envOverride || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return await streamChildOutput(child, `${command} ${args.join(" ")}`, onLine);
}

// Shared line pump for the streamed runners. #223 W4: every chunk is appended
// to its accumulator EXACTLY once and the line splitter keeps its own buffer
// (the old pump never wrote stdout - always empty in failure messages - and
// double-counted stderr partial lines across chunks).
async function streamChildOutput(child, command, onLine) {
  // Watchdog: grandchildren can inherit and hold the stdio pipes, so the
  // child's 'exit' may fire but 'close' never does and callers hang. If the
  // stream goes silent for 20s AFTER the child exits, force-settle.
  let exited = false;
  let lastActivity = Date.now();
  child.on("exit", () => { exited = true; lastActivity = Date.now(); });
  const watchdog = setInterval(() => {
    if (exited && Date.now() - lastActivity > 20000) {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }
  }, 5000);
  const bump = () => { lastActivity = Date.now(); };
  let stdout = "";
  let stderr = "";
  const pump = (stream, append) => {
    let pending = "";
    stream?.on("data", (chunk) => {
      const text = String(chunk || "");
      append(text);
      pending += text;
      let idx;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (line) { onLine(line); bump(); }
      }
    });
  };
  pump(child.stdout, (text) => { stdout += text; });
  pump(child.stderr, (text) => { stderr += text; });
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearInterval(watchdog);
      const result = { ok: code === 0, code, signal, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) return resolve(result);
      const failure = new Error(stderr.trim() || stdout.trim() || `Command failed: ${command}`);
      Object.assign(failure, result);
      reject(failure);
    });
  });
}

// Window chrome colors per theme (kept in sync with renderer/style.css).
const THEME_CHROME = {
  day: { background: "#faf9f7", symbol: "#26231d" },
  night: { background: "#131109", symbol: "#f0ece3" },
};

function effectiveTheme(theme) {
  if (theme === "day" || theme === "night") return theme;
  return nativeTheme.shouldUseDarkColors ? "night" : "day";
}

async function createMainWindow() {
  const settings = await loadSettings();
  const chrome = THEME_CHROME[effectiveTheme(settings.theme)];
  // Titleless chrome: the OS title bar is replaced by an in-page drag
  // region (renderer/.titlebar) so the app title merges with the shell.
  // macOS keeps native traffic lights (hiddenInset); Windows/Linux draw
  // native min/max/close over the page via titleBarOverlay, tinted to the
  // page background for a seamless look.
  const isDarwin = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1580,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: chrome.background,
    title: "TeamClaw Desktop",
    icon: getDesktopIconPath(),
    titleBarStyle: isDarwin ? "hiddenInset" : "hidden",
    ...(isDarwin ? {} : {
      titleBarOverlay: {
        color: chrome.background,
        symbolColor: chrome.symbol,
        height: 40,
      },
    }),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // #223 W6 (kept false, deliberate): sandboxed preloads must be
      // CommonJS - Electron does not load ESM preload scripts under
      // sandbox:true, and preload.mjs is an ES module (contextBridge +
      // ipcRenderer only, no Node APIs). Converting it to preload.cjs is the
      // prerequisite for sandbox:true and is left as a follow-up (it changes
      // the packaged entry, outside this fix's file scope).
      sandbox: false,
    },
  });

  await mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Warm the compressed bundled runtime early so wizard clicks never wait
  // on a first-use extraction (best effort - failures degrade to npm).
  warmBundledRuntime().catch(() => {});
  // No app.dock.setIcon here: the Dock icon comes from the bundle icns
  // (build/icon.icns = site claw mark). The old runtime override pointed at
  // a legacy PNG and masked the bundle icon on every launch.
  await createMainWindow();
  // Test hook (dev/CI driving, env-gated): when TC_TEST_HOOK is set, poll a
  // command file and execute each line as JS inside the renderer; the JSON
  // result is appended to <file>.result. Coordinates-free UI automation -
  // vision-coordinate clicking proved unreliable for Electron DOM.
  if (process.env.TC_TEST_HOOK) {
    const hookFile = process.env.TC_TEST_HOOK;
    const resultFile = `${hookFile}.result`;
    setInterval(async () => {
      let line = "";
      try { line = (await fs.readFile(hookFile, "utf8")).trim(); } catch { return; }
      if (!line) return;
      try { await fs.writeFile(hookFile, "", { mode: 0o600 }); } catch { /* race */ }
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      let out = { error: "no window" };
      try {
        out = { value: await win.webContents.executeJavaScript(`(${line})()`) };
      } catch (e) { out = { error: e instanceof Error ? e.message : String(e) }; }
      try { await fs.appendFile(resultFile, JSON.stringify(out) + "\n"); } catch { /* best effort */ }
    }, 500);
  }
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// #223 W5: navigation guards. This app is a local-file UI; any in-page
// navigation away from this renderer's OWN directory is a bug or an injected
// link - block it (cross-review tightening: plain file:// prefix would still
// allow navigating to any local file). Genuine http(s) popups go to the
// system browser instead of a child window.
const RENDERER_ROOT = path.join(__dirname, "renderer") + path.sep;
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, navigationUrl) => {
    try {
      if (new URL(contents.getURL()).protocol === "devtools:") return;
    } catch { /* current URL unparseable - apply the guard */ }
    let inRendererDir = false;
    try {
      const target = new URL(String(navigationUrl || ""));
      // fileURLToPath yields the platform-native path (a raw pathname would
      // keep a leading slash before the drive letter on Windows).
      inRendererDir = target.protocol === "file:" &&
        path.normalize(fileURLToPath(target)).startsWith(RENDERER_ROOT);
    } catch { /* unparseable target - keep blocked */ }
    if (!inRendererDir) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(String(url || ""))) {
      shell.openExternal(url).catch(() => { /* best effort */ });
    }
    return { action: "deny" };
  });
});

ipcMain.handle("window:apply-theme", async (_event, theme) => {
  const chrome = THEME_CHROME[theme === "night" ? "night" : "day"];
  if (mainWindow) {
    mainWindow.setBackgroundColor(chrome.background);
    if (process.platform !== "darwin") {
      try {
        mainWindow.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol });
      } catch {
        /* setTitleBarOverlay unsupported on this platform/build */
      }
    }
  }
  return { ok: true };
});
ipcMain.handle("settings:get", async () => loadSettings());
ipcMain.handle("settings:save", async (_event, settings) => {
  // `instance` is owned exclusively by instance:set. Renderer preferences are
  // saved from a snapshot taken at boot, which would otherwise clobber the
  // instance record written later (a real bug: mode/ports silently lost).
  const current = await loadSettings().catch(() => ({}));
  const next = { ...settings };
  // HARD ownership rule: renderer snapshots carry a boot-time instance value
  // (often explicit null) that would clobber a record written afterwards.
  // instance belongs to instance:set alone.
  delete next.instance;
  next.instance = current.instance ?? null;
  return saveSettings(next);
});
/* ---------------- Standalone instance (fully isolated) ----------------
 * A desktop-owned OpenClaw+TeamClaw instance:
 *   - state dir: userData/standalone-state (OPENCLAW_STATE_DIR) - never the
 *     user's ~/.openclaw
 *   - runtime: the sandboxed npm-prefix binaries from bootstrap (or the
 *     user-installed openclaw binary, executed read-only)
 *   - its own port (auto-picked free port)
 *   - LLM config defaults to a READ-ONLY COPY of the user's config; the
 *     desktop may override the vendor - written only into the sandbox copy
 *   - started/stopped with the desktop app; killed on quit, pid-guarded
 */
const STANDALONE = { child: null, port: null, pid: null, controllerUrl: null };

/* Gateway process lifecycle (#223 W3). Gateways used to spawn through a
 * shell ('sh -c "<bin> gateway ..."'): SIGTERM killed the /bin/sh wrapper and
 * orphaned the node grandchild holding the port. Every gateway now spawns
 * WITHOUT a shell (openClawSpawnPlan above resolves any bin shape into an
 * execPath/ELECTRON_RUN_AS_NODE recipe), detached on POSIX so the gateway
 * leads its own process group (its workers spawn inside the group), and the
 * log fd is closed when the child exits (one fd used to leak per start).
 */
function spawnGatewayProcess(bin, gatewayArgs, { cwd, env, logPath }) {
  const logFd = fsSync.openSync(logPath, "a");
  let logClosed = false;
  const closeLog = () => {
    if (logClosed) return;
    logClosed = true;
    try { fsSync.closeSync(logFd); } catch { /* already closed */ }
  };
  const args = [String(gatewayArgs[0]), ...gatewayArgs.slice(1).map(String)];
  // A bare name never reaches a PATH lookup at spawn time (#220 discipline):
  // resolve it first, then plan the shell-free spawn.
  const resolvedBin = typeof bin === "string" && !path.isAbsolute(bin)
    ? (resolvedOpenClawBinary() || bin)
    : bin;
  const plan = openClawSpawnPlan(resolvedBin, args);
  let child;
  if (plan) {
    child = spawn(plan.command, plan.args, {
      cwd,
      env: { ...(env || process.env), ...(plan.env || {}) },
      stdio: ["ignore", logFd, logFd],
      detached: process.platform !== "win32", // group leader -> kill(-pid)
    });
  } else {
    // Windows .cmd fallback: the ONLY remaining shell spawn; stop paths
    // escalate to `taskkill /T` so the wrapper never strands the grandchild.
    child = spawn(`"${resolvedBin}" ${args.join(" ")}`, {
      cwd,
      env: env || process.env,
      shell: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.wasShellSpawned = true;
  }
  child.on("exit", closeLog);
  child.on("error", closeLog);
  return child;
}

// Kill a gateway's whole tree. POSIX: -pid signals the process group (node +
// spawned workers) at once, falling back to a direct kill once the group is
// gone. Windows shell-wrapped children need `taskkill /T /F`.
function killGatewayTree(child, pid = null, signal = "SIGTERM") {
  const target = pid ?? (child && child.pid) ?? null;
  if (!target) return;
  if (process.platform === "win32" || (child && child.wasShellSpawned)) {
    if (child && !child.wasShellSpawned) {
      try { child.kill(signal); } catch { /* gone */ }
    }
    try {
      spawn("taskkill", ["/PID", String(target), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* taskkill unavailable - best effort */ }
    return;
  }
  try { process.kill(-target, signal); return; } catch { /* group gone */ }
  if (child) {
    try { child.kill(signal); return; } catch { /* gone */ }
  }
  try { process.kill(target, signal); } catch { /* gone */ }
}

function standaloneStateDir() {
  // The private instance RUNS on the bootstrap sandbox state - one sandbox
  // holds both the registered plugin and the running gateway. A separate
  // standalone-state dir used to split them (plugin registered in one,
  // gateway in the other - controller never came up).
  return path.join(app.getPath("userData"), "openclaw-state");
}
function standalonePidFile() {
  return path.join(standaloneStateDir(), "gateway.pid");
}

async function findFreePort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function standaloneBinary() {
  // Same resolution order as the installer (bundled > sandbox runtime >
  // global read-only). A bundled install wrote the sandbox state with the
  // bundled (newer) openclaw - running the OLDER global binary against it
  // is refused by the gateway ("older than the config last written by").
  const bundled = bundledBinary("openclaw");
  if (bundled) return bundled;
  const sandboxBin = path.join(app.getPath("userData"), "runtime", "node_modules", ".bin", "openclaw");
  if (fsSync.existsSync(sandboxBin)) return sandboxBin;
  // probeOpenClawInstall treats "binary resolves but --help fails under load"
  // as installed-with-warning (#140) - the gateway can still be spawned; do
  // not let a busy production gateway degrade this into the missing-runtime
  // error path.
  const probe = await probeOpenClawInstall();
  if (probe.installed) return "openclaw";
  throw new Error("No OpenClaw runtime available - run the one-click install first.");
}

async function seedStandaloneConfig(preferredVendor, controllerPort, teamProfile) {
  // Minimal-config seeding: a full copy of the user's config made the
  // gateway normalize production-specific fields at startup, tripping its
  // own config-guard ("config changed during startup") in a loop. Instead
  // write ONLY {gateway.mode:local} + the LLM providers already configured
  // in the bootstrap sandbox (read-only source; user config never read or
  // written here).
  const stateDir = standaloneStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  const dst = path.join(stateDir, "openclaw.json");
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(dst, "utf8")); } catch { cfg = {}; }
  cfg.gateway = { ...(cfg.gateway || {}), mode: "local" };
  cfg.models = cfg.models || { providers: {} };
  cfg.models.providers = cfg.models.providers || {};
  const bootstrapCfg = path.join(app.getPath("userData"), "openclaw-state", "openclaw.json");
  try {
    const b = JSON.parse(await fs.readFile(bootstrapCfg, "utf8"));
    for (const [id, p] of Object.entries(b?.models?.providers || {})) {
      cfg.models.providers[id] = { ...(cfg.models.providers[id] || {}), ...p };
    }
  } catch { /* bootstrap not run yet - empty providers */ }
  if (preferredVendor && cfg.models.providers[preferredVendor]) cfg.preferredVendor = preferredVendor;
  // Declare the plugin in controller mode - without this the gateway starts
  // the teamclaw plugin as a WORKER (it just polls for a controller and the
  // desktop dashboard never gets its API).
  cfg.plugins = cfg.plugins || { entries: {} };
  cfg.plugins.entries = cfg.plugins.entries || {};
  cfg.plugins.entries.teamclaw = {
    ...(cfg.plugins.entries.teamclaw || {}),
    enabled: true,
    config: {
      ...(cfg.plugins.entries.teamclaw?.config || {}),
      mode: "controller",
      teamName: "private",
      // Wizard team type (Phase 5.2): bootstrap value only - first write
      // wins, and the controller ignores it once a TeamState exists
      // (vertical-team-profiles-design.md 2.3 single source of truth).
      ...((teamProfile && !cfg.plugins.entries.teamclaw?.config?.teamProfile) ? { teamProfile } : {}),
      // Pin the controller port so restarts land on the remembered one; the
      // plugin auto-shifts (9527 -> 9627 ...) when it is occupied, and the
      // actual bound port is recorded back into settings afterwards.
      ...(controllerPort ? { port: controllerPort } : {}),
    },
  };
  await fs.writeFile(dst, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return dst;
}

async function standaloneStart(preferredVendor, remembered, teamProfile) {
  if (STANDALONE.child) return { ok: true, alreadyRunning: true, port: STANDALONE.port };
  // Port memory: reuse the ports recorded in settings.instance so restarts
  // land on the SAME gateway/controller ports (probed + persisted below).
  const bin = await standaloneBinary();
  // Idempotent seed: a rewrite (even identical) trips the gateway config-guard
  // ("config changed during startup") and kills the spawn. Only seed when the
  // sandbox config is missing or lacks any models.providers entry.
  const sandboxCfgPath = path.join(standaloneStateDir(), "openclaw.json");
  let needsSeed = true;
  try {
    const c = JSON.parse(await fs.readFile(sandboxCfgPath, "utf8"));
    const noLlm = !c?.models?.providers || Object.keys(c.models.providers).length === 0;
    const noGateway = !c?.gateway?.mode;
    const noController = c?.plugins?.entries?.teamclaw?.config?.mode !== "controller";
    needsSeed = noLlm || noGateway || noController;
  } catch { /* missing -> seed */ }
  // Conflict-checked port fallback (user rule): BOTH the openclaw gateway
  // port and the teamclaw controller port are probed BEFORE launch; an
  // occupied preferred port falls back to the next free one (preferred+1..
  // preferred+50, else any free port). The chosen pair is persisted into
  // settings.instance FIRST - then the processes start on exactly those
  // ports - so a restart lands on the same ports without re-shifting.
  const isFreeLocal = async (port) => {
    if (!port) return false;
    const net = await import("node:net");
    return await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
  };
  const pickPortWithFallback = async (preferred, fallbackBase) => {
    const base = Number.isFinite(preferred) && preferred > 0 ? preferred : fallbackBase;
    if (await isFreeLocal(base)) return base;
    for (let p = fallbackBase; p < fallbackBase + 50; p++) {
      if (await isFreeLocal(p)) return p;
    }
    return await findFreePort();
  };
  const persistInstancePorts = async (instance) => {
    try {
      const s = await loadSettings();
      s.instance = { ...(s.instance || {}), ...instance };
      await saveSettings(s);
    } catch { /* settings write failure must not kill the launch */ }
  };
  const wantCtrl = Number(remembered?.controllerPort) || null;
  const ctrlPort = await pickPortWithFallback(wantCtrl, 9527);
  const gwPort = await pickPortWithFallback(Number(remembered?.gatewayPort) || null, ctrlPort + 100);
  // Land the chosen pair BEFORE spawning anything (config + settings).
  await persistInstancePorts({ mode: "private", gatewayPort: gwPort, controllerPort: ctrlPort });
  if (needsSeed) await seedStandaloneConfig(preferredVendor, ctrlPort, teamProfile);
  else {
    // Pin the conflict-checked controller port into the sandbox config so
    // the plugin does not race its own auto-shift against a taken 9527.
    try {
      const c = JSON.parse(await fs.readFile(sandboxCfgPath, "utf8"));
      const cur = c?.plugins?.entries?.teamclaw?.config?.port;
      if (cur !== ctrlPort) await seedStandaloneConfig(preferredVendor, ctrlPort, teamProfile);
    } catch { await seedStandaloneConfig(preferredVendor, ctrlPort, teamProfile); }
  }
  STANDALONE.port = gwPort;
  const logPath = path.join(standaloneStateDir(), "gateway.log");
  const child = spawnGatewayProcess(bin, ["gateway", "--port", String(STANDALONE.port)], {
    cwd: standaloneStateDir(),
    env: { ...process.env, OPENCLAW_STATE_DIR: standaloneStateDir() },
    logPath,
  });
  STANDALONE.child = child;
  STANDALONE.pid = child.pid ?? null;
  await fs.writeFile(standalonePidFile(), String(child.pid ?? ""), { mode: 0o600 });
  child.on("exit", () => {
    STANDALONE.child = null;
    STANDALONE.pid = null;
    try { fsSync.rmSync(standalonePidFile(), { force: true }); } catch { /* gone */ }
  });
  // The teamclaw controller picks its own HTTP port (9527, auto-shifted when
  // occupied - e.g. 9537 next to a production controller). Wait for its
  // announce line in the gateway log and surface THAT as the controllerUrl.
  let controllerUrl = null;
  for (let i = 0; i < 40 && !controllerUrl; i++) {
    try {
      const log = await fs.readFile(logPath, "utf8");
      const m = log.match(/Controller: Web UI available at http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) controllerUrl = `http://127.0.0.1:${m[1]}`;
    } catch { /* log not written yet */ }
    if (!controllerUrl) await new Promise((r) => setTimeout(r, 1000));
  }
  // First-boot worker race auto-heal (user-found): a provisioned worker can
  // spawn inside the gateway's config-normalization window and die on the
  // config-guard ("config changed during startup - Retry startup"). The
  // provisioner does not retry, leaving startup readiness degraded and no
  // model ever runs. One bounded respawn fixes it: on the second boot the
  // config journal has settled and the worker passes.
  if (controllerUrl) {
    const logText = async () => { try { return await fs.readFile(logPath, "utf8"); } catch { return ""; } };
    const announceCount = (t) => (t.match(/Controller: Web UI available at/g) || []).length;
    const respawn = async () => {
      const before = announceCount(await logText());
      killGatewayTree(child);
      await new Promise((r) => { child.once("exit", r); setTimeout(r, 4000); });
      const child2 = spawnGatewayProcess(bin, ["gateway", "--port", String(STANDALONE.port)], {
        cwd: standaloneStateDir(),
        env: { ...process.env, OPENCLAW_STATE_DIR: standaloneStateDir() },
        logPath,
      });
      STANDALONE.child = child2;
      STANDALONE.pid = child2.pid ?? null;
      await fs.writeFile(standalonePidFile(), String(child2.pid ?? ""), { mode: 0o600 });
      child2.on("exit", () => {
        STANDALONE.child = null;
        STANDALONE.pid = null;
        try { fsSync.rmSync(standalonePidFile(), { force: true }); } catch { /* gone */ }
      });
      // Wait for a NEW announce line (the old one is still in the log).
      let url = null;
      for (let j = 0; j < 40 && !url; j++) {
        const t = await logText();
        if (announceCount(t) > before) {
          const all = t.match(/Controller: Web UI available at http:\/\/127\.0\.0\.1:(\d+)/g) || [];
          const last = all[all.length - 1] || "";
          const m2 = last.match(/:(\d+)$/);
          if (m2) url = `http://127.0.0.1:${m2[1]}`;
        }
        if (!url) await new Promise((r) => setTimeout(r, 1000));
      }
      return url;
    };
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const t = await logText();
      const guardRace = /config changed during startup/.test(t) && /Provisioner: process worker [^\n]* exited/.test(t);
      if (!guardRace) continue;
      controllerUrl = (await respawn()) || controllerUrl;
      break;
    }
  }
  STANDALONE.controllerUrl = controllerUrl;
  // If the controller still auto-shifted despite the pinned port (race with
  // another process grabbing it between probe and bind), persist the ACTUAL
  // bound port so the next start remembers reality.
  const actualCtrl = controllerUrl ? Number(new URL(controllerUrl).port) : null;
  if (actualCtrl && actualCtrl !== ctrlPort) {
    await persistInstancePorts({ controllerPort: actualCtrl, controllerUrl });
  }
  const mPort = controllerUrl ? Number(new URL(controllerUrl).port) : null;
  return {
    ok: true,
    port: STANDALONE.port,
    pid: child.pid ?? null,
    controllerUrl: controllerUrl || `http://127.0.0.1:${STANDALONE.port}`,
    controllerPort: Number.isFinite(mPort) ? mPort : null,
  };
}

async function standaloneStop() {
  if (!STANDALONE.child) {
    // Stale pid from a previous run (crashed desktop): reap if alive.
    try {
      const pid = Number((await fs.readFile(standalonePidFile(), "utf8")).trim());
      if (pid) {
        process.kill(pid, 0); // throws if dead
        killGatewayTree(null, pid, "SIGTERM");
        // #223 W3: bounded escalation - a stuck gateway must not survive a
        // stop request just because SIGTERM was ignored.
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 400));
          let alive = false;
          try { process.kill(pid, 0); alive = true; } catch { /* down */ }
          if (!alive) break;
          if (i === 10) killGatewayTree(null, pid, "SIGKILL");
        }
      }
    } catch { /* not running */ }
    try { fsSync.rmSync(standalonePidFile(), { force: true }); } catch { /* gone */ }
    return { ok: true, alreadyRunning: false };
  }
  const child = STANDALONE.child;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    child.once("exit", done);
    killGatewayTree(child);
    // #223 W3: this used to resolve blindly after 4s while a hung gateway
    // kept holding the port. Escalate to SIGKILL, then settle regardless.
    setTimeout(() => {
      if (settled) return;
      killGatewayTree(child, null, "SIGKILL");
      setTimeout(done, 800);
    }, 4000);
  });
  return { ok: true };
}

function standaloneStatus() {
  return {
    running: Boolean(STANDALONE.child),
    port: STANDALONE.port,
    pid: STANDALONE.pid,
    controllerUrl: STANDALONE.controllerUrl || null,
    stateDir: standaloneStateDir(),
  };
}

ipcMain.handle("standalone:start", async (_e, options) =>
  standaloneStart(options?.preferredVendor, options?.instance || null, options?.teamProfile || null)
);
ipcMain.handle("standalone:stop", () => standaloneStop());
ipcMain.handle("standalone:status", () => standaloneStatus());

// App lifecycle: the private instance dies with the app UNLESS the user
// chose "persistent" (keep it running in the background so the next app
// start reconnects instantly). Global gateways are always left running.
// #223 W3: quit handling is SYNCHRONOUS w.r.t. the cached instance record
// (see cachedInstanceRecord) and holds the quit open until the process tree
// is actually down - the old async listener could exit mid-read and orphan
// the gateway.
let gatewayTeardownStarted = false;
app.on("before-quit", (event) => {
  const lifecycle = cachedInstanceRecord?.lifecycle || "app";
  if (lifecycle !== "app" || gatewayTeardownStarted) return;
  gatewayTeardownStarted = true;
  event.preventDefault();
  void (async () => {
    try {
      const live = STANDALONE.child;
      let target = live ? live.pid : null;
      if (!target) {
        try { target = Number(fsSync.readFileSync(standalonePidFile(), "utf8").trim()) || null; } catch { target = null; }
      }
      if (target) {
        killGatewayTree(live, target, "SIGTERM");
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 250));
          let alive = false;
          try { process.kill(target, 0); alive = true; } catch { /* down */ }
          if (!alive) break;
          if (i === 7) killGatewayTree(live, target, "SIGKILL"); // ~1.75s grace
        }
      }
    } catch { /* teardown must never block quit */ }
    app.exit(0);
  })();
});

// Readiness gate: fully-offline two probes against the DESKOP SANDBOX state.
// ready = LLM configured (any models.providers[*].apiKey) AND teamclaw registered.
// ---- Instance manager: one IPC family driven ONLY by settings.instance ----
ipcMain.handle("instance:get", async () => (await loadSettings()).instance);
ipcMain.handle("instance:set", async (_e, instance) => {
  const settings = await loadSettings();
  settings.instance = instance || null;
  await saveSettings(settings);
  return settings.instance;
});
// Environment detection for the wizard (READ-ONLY). Decides the DEFAULT
// option: both present -> connect existing; openclaw only -> install into
// it (or private); neither -> full global install (private optional).
ipcMain.handle("env:detect", async () => {
  const globalState = path.join(os.homedir(), ".openclaw");
  const cfgPath = path.join(globalState, "openclaw.json");
  let cfg = null;
  try { cfg = JSON.parse(await fs.readFile(cfgPath, "utf8")); } catch { /* none */ }
  const openclaw = Boolean(cfg) || (await hasOpenClawInstalled());
  // teamclaw registered in the GLOBAL state? plugins.entries or extensions dir.
  const teamclawInGlobal = Boolean(
    cfg?.plugins?.entries?.teamclaw ||
    fsSync.existsSync(path.join(globalState, "plugins", "teamclaw"))
  );
  // Global controller URL is only inferred from the GLOBAL state, never
  // probed on a fixed port: a sandboxed desktop must not mistake a
  // foreign/production controller for its own. Liveness is checked later,
  // at connect time, by the caller.
  const globalControllerUrl = teamclawInGlobal
    ? `http://127.0.0.1:${controllerPortFromConfig(cfg)}`
    : null;
  return { openclaw, teamclawInGlobal, globalControllerUrl, llmConfigured: Boolean(cfg && Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey)), llmProviders: cfg ? Object.entries(cfg?.models?.providers || {}).filter(([, p]) => p && p.apiKey).map(([id]) => id) : [], llmDefaultModel: (cfg?.agents?.defaults?.model || "") || null };
});


// Per-instance controller port: never assume the process-global 9527 - each
// OpenClaw instance (global or private) may run its controller on its own
// pinned/auto-shifted port. Read it from THAT state dir's config, then from
// the gateway log announce line (the source of truth after auto-shift).
function controllerPortFromConfig(cfg) {
  const p = Number(cfg?.plugins?.entries?.teamclaw?.config?.port);
  return Number.isFinite(p) && p > 0 ? p : 9527;
}
async function resolveInstanceControllerUrl(stateDir, cfgPort, logPaths) {
  const candidates = logPaths || [path.join(stateDir, "gateway.log"), path.join(stateDir, "logs", "gateway.log")];
  for (let i = 0; i < 45; i++) {
    for (const lp of candidates) {
      try {
        const log = await fs.readFile(lp, "utf8");
        // Announce line shape: "Controller: Web UI available at http://127.0.0.1:<port>/ui"
        // The /ui suffix is part of the real message - never anchor on end-of-string.
        const re = /Controller: Web UI available at http:\/\/127\.0\.0\.1:(\d+)/g;
        let last = null;
        for (let mm = re.exec(log); mm; mm = re.exec(log)) last = mm[1];
        if (last) {
          {
            const url = `http://127.0.0.1:${last}`;
            try {
              const r = await fetch(`${url}/api/v1/tunnel/status`, { signal: AbortSignal.timeout(1500) });
              if (r.ok) return url;
            } catch { /* announced but not answering yet */ }
          }
        }
      } catch { /* log not there yet */ }
    }
    // NO blind probe of the configured port: on a machine that already runs
    // another controller, that port belongs to a DIFFERENT instance and
    // accepting it silently attaches this app to a foreign gateway. The
    // announce line is the only trustworthy source; cfgPort is just a hint
    // for the caller's own diagnostics.
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

// Global-mode detection for the wizard: does the machine-level OpenClaw have
// a pre-existing state (LLM already configured)? Read-only.
ipcMain.handle("global:probe", async () => {
  const statePath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const cfg = JSON.parse(await fs.readFile(statePath, "utf8"));
    const llm = Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey);
    return { present: true, llmConfigured: llm, binary: await hasOpenClawInstalled() };
  } catch {
    return { present: false, llmConfigured: false, binary: await hasOpenClawInstalled() };
  }
});
// Global-mode gateway: spawn the system openclaw gateway (default state dir,
// NO sandbox env). Fresh installs get LLM written by the wizard first;
// pre-existing state is reused untouched.
async function globalGatewayStart(preferredPort, extraEnv, binOverride) {
  const port = Number(preferredPort) || (await findFreePort());
  const env = { ...(extraEnv || process.env) };
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_PROFILE;
  // Blank machine (user-found on Windows): no `openclaw` on PATH - the
  // wizard's global install self-provisions a runtime and hands its absolute
  // binary here; PATH fallback keeps existing behavior.
  const bin = binOverride || bundledBinary("openclaw") || "openclaw";
  const child = spawnGatewayProcess(bin, ["gateway", "--port", String(port)], {
    cwd: env.HOME || process.env.HOME || process.cwd(),
    env,
    logPath: path.join(app.getPath("userData"), "global-gateway.log"),
  });
  GLOBAL_GATEWAY.child = child;
  GLOBAL_GATEWAY.port = port;
  return { ok: true, port, pid: child.pid ?? null };
}
const GLOBAL_GATEWAY = { child: null, port: null };
// Install TeamClaw INTO the existing global OpenClaw (user-chosen path; the
// only flow allowed to write the global state - explicit consent by choice).
// Backs up the global cfg to the desktop dir first, then registers the plugin
// with the system openclaw CLI (global state, no sandbox env) and restarts the
// LaunchAgent gateway so the controller comes up.
ipcMain.handle("instance:install-into-global", async (event, options) => {
  const onEvent = (e) => { try { event.sender.send("bootstrap:install-event", e); } catch {} };
  const globalCfg = path.join(process.env.HOME || process.env.USERPROFILE || process.cwd(), ".openclaw", "openclaw.json");
  try {
    const bak = path.join(app.getPath("userData"), `global-cfg-backup-${Date.now()}.json`);
    await fs.copyFile(globalCfg, bak).catch(() => {});
    onEvent({ phase: "teamclaw", line: "Backed up global config to " + bak });
  } catch { /* no cfg yet */ }
  // Target the GLOBAL state explicitly: the app process may already carry a
  // private instance's OPENCLAW_STATE_DIR, and inheriting it would install
  // into the wrong instance.
  const gHome = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const gEnv = { ...process.env, HOME: gHome, OPENCLAW_HOME: gHome };
  delete gEnv.OPENCLAW_STATE_DIR;
  delete gEnv.OPENCLAW_PROFILE;
  // Blank machine: no `openclaw` on PATH. Self-provision a runtime first
  // (bundled or sandbox npm install - no system npm required when bundled)
  // and use ITS binary everywhere below; the old PATH-only commands failed
  // and left the wizard stuck on step 3 forever.
  let bin = "openclaw";
  if (!(await hasOpenClawInstalled())) {
    onEvent({ phase: "openclaw", line: "No OpenClaw on this machine - provisioning a runtime first..." });
    bin = await ensureOpenClawRuntime({ source: "auto" }, onEvent);
    onEvent({ phase: "openclaw", line: "Runtime ready: " + bin });
  }
  onEvent({ phase: "teamclaw", line: "Installing TeamClaw into the global OpenClaw (explicit choice)..." });
  await runShellStream(`"${bin}" plugins install @teamclaws/teamclaw --force --accept-capabilities`, gHome, (line) =>
    onEvent({ phase: "teamclaw", line }), gEnv);
  // The plugin defaults to WORKER mode; the desktop app needs this instance to
  // BE the controller. Without this the global gateway loads teamclaw as a
  // worker ("Identity: no controller found") and no dashboard API ever exists.
  // options.teamProfile (Phase 5.2 wizard team type) is a bootstrap value:
  // first write wins - an existing teamProfile is never overwritten, and the
  // controller ignores it once a TeamState exists (design 2.3).
  const gCfgPath = path.join(gHome, ".openclaw", "openclaw.json");
  const teamProfile = (options && options.teamProfile) || null;
  try {
    const c = JSON.parse(await fs.readFile(gCfgPath, "utf8"));
    c.plugins = c.plugins || {};
    c.plugins.entries = c.plugins.entries || {};
    const prev = c.plugins.entries.teamclaw || {};
    c.plugins.entries.teamclaw = {
      ...prev,
      enabled: true,
      config: {
        ...(prev.config || {}),
        mode: "controller",
        teamName: prev.config?.teamName || "global",
        ...((teamProfile && !prev.config?.teamProfile) ? { teamProfile } : {}),
      },
    };
    await fs.writeFile(gCfgPath, JSON.stringify(c, null, 2), { mode: 0o600 });
    onEvent({ phase: "teamclaw", line: "Global instance set to controller mode." });
  } catch (e) {
    onEvent({ phase: "teamclaw", line: "Could not set controller mode: " + (e && e.message) });
  }
  onEvent({ phase: "teamclaw", line: "Restarting the global gateway..." });
  let restarted = true;
  try {
    await runShellStream(`"${bin}" gateway restart`, gHome, (line) =>
      onEvent({ phase: "teamclaw", line }), gEnv);
  } catch {
    // No service manager (fresh machine, sandbox, Linux w/o systemd unit):
    // restart is not available, so start the gateway ourselves instead of
    // failing the whole install.
    restarted = false;
  }
  if (!restarted) {
    let gPort = 18789;
    try {
      const c = JSON.parse(await fs.readFile(path.join(gHome, ".openclaw", "openclaw.json"), "utf8"));
      gPort = Number(c?.gateway?.port) || 18789;
    } catch { /* default */ }
    onEvent({ phase: "teamclaw", line: `No gateway service found - starting one on port ${gPort}...` });
    await globalGatewayStart(gPort, { ...gEnv, HOME: gHome }, bin);
  }
  // Resolve THIS instance's controller (pinned or auto-shifted port) from its
  // own config + gateway log - never the process-global 9527 default, which
  // may be another instance entirely.
  const gStateDir = gHome;
  let gCfg = null;
  try { gCfg = JSON.parse(await fs.readFile(path.join(gStateDir, "openclaw.json"), "utf8")); } catch { /* none */ }
  const controllerUrl = await resolveInstanceControllerUrl(gStateDir, controllerPortFromConfig(gCfg), [
    path.join(app.getPath("userData"), "global-gateway.log"),
    path.join(gStateDir, "gateway.log"),
    path.join(gStateDir, "logs", "gateway.log"),
  ]);
  if (!controllerUrl) throw new Error(`Global controller did not come up in ${gStateDir} after install.`);
  onEvent({ phase: "done", line: "Global TeamClaw ready at " + controllerUrl });
  return { ok: true, controllerUrl };
});

ipcMain.handle("instance:start-global", (_e, port) => globalGatewayStart(port));

ipcMain.handle("runtime:is-ready", async () => {
  const stateDir = path.join(app.getPath("userData"), "openclaw-state");
  let llm = false, plugin = false;
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(stateDir, "openclaw.json"), "utf8"));
    llm = Object.values(cfg?.models?.providers || {}).some((p) => p && p.apiKey);
    // Plugin presence = registered in openclaw.json (the "Saved for the next
    // Gateway start" record). The old extensions/teamclaw/dist probe missed
    // npm-source installs (they land in npm/projects and only register in
    // the config), so readiness read false and boot fell back to the wizard.
    plugin = Boolean(cfg?.plugins?.entries?.teamclaw);
  } catch { /* no cfg */ }
  try {
    // Binary candidates kept as a secondary signal (bundled/sandbox/global).
    const candidates = [
      bundledBinary("openclaw"),
      path.join(app.getPath("userData"), "runtime", "node_modules", ".bin", "openclaw"),
      (await hasOpenClawInstalled()) ? "openclaw" : null,
    ];
    const cand = candidates.find(Boolean) || null;
    if (!plugin) plugin = Boolean(cand) && fsSync.existsSync(path.join(stateDir, "extensions", "teamclaw", "dist", "index.js"));
    void cand;
  } catch { /* no runtime */ }
  // Readiness = plugin installed + runtime binary present. LLM keys must NOT
  // gate readiness: "configure later" is a supported wizard path, and a
  // user who finished the install should boot straight into their private
  // instance (llm is still reported separately for the wizard to surface).
  return { ready: plugin, llm, plugin };
});

ipcMain.handle("bootstrap:install", async (event, options) => {
  // Orchestrate the sandboxed bootstrap with streamed progress events.
  // NEVER touches the user's global installs or ~/.openclaw (hard rule).
  const onEvent = (e) => {
    try { event.sender.send("bootstrap:install-event", e); } catch { /* window gone */ }
  };
  const { llm, source, artifactUrl } = options || {};
  try {
    onEvent({ phase: "start", line: "Starting sandboxed bootstrap..." });
    onEvent({ phase: "diag", line: "rp=" + (process.resourcesPath||"none") });
    {
      const base = path.join(process.resourcesPath || "", "bin");
      const t1 = path.join(base, "runtime", "node_modules", ".bin", "openclaw");
      onEvent({ phase: "diag", line: "bin-dir=" + fsSync.existsSync(base) + " tree=" + fsSync.existsSync(t1) + " lstat=" + (() => { try { return fsSync.lstatSync(t1).isSymbolicLink(); } catch { return "ERR:"; } })() });
    }
    const openclawBin = await ensureOpenClawRuntime({ source, artifactUrl }, onEvent);
    await ensureTeamClawPlugin(openclawBin, onEvent);
    await writeLlmConfig(openclawBin, llm || {}, onEvent);
    // Settle pass (user-found worker config-guard race): the FIRST gateway
    // boot normalizes freshly-written config (e.g. agents.defaults.model is
    // canonicalized to "provider/<catalog-id>"), and a worker provisioned in
    // that window dies on the config-guard ("config changed during startup")
    // - the provisioner then degrades readiness and no model ever runs.
    // One headless boot right here lets normalization land on disk BEFORE
    // the interactive start, so its first workers boot against settled
    // config (verified: second boot rewrites nothing).
    if (llm && llm.provider && llm.apiKey) {
      onEvent({ phase: "llm", line: "Settling gateway config (one headless boot)..." });
      try {
        const settlePort = await findFreePort();
        const stateDir = path.join(app.getPath("userData"), "openclaw-state");
        const settleEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        const settlePlan = openClawSpawnPlan(openclawBin, ["gateway", "--port", String(settlePort)]);
        const settle = settlePlan
          ? spawn(settlePlan.command, settlePlan.args, {
              cwd: stateDir,
              env: { ...settleEnv, ...settlePlan.env },
              stdio: "ignore",
              detached: false,
            })
          : spawn(`"${openclawBin}" gateway --port ${settlePort}`, {
              cwd: stateDir,
              env: settleEnv,
              shell: true,
              stdio: "ignore",
              detached: false,
            });
        await new Promise((r) => setTimeout(r, 9000));
        killGatewayTree(settle, null, "SIGTERM");
        await new Promise((r) => { settle.once("exit", r); setTimeout(r, 4000); });
        onEvent({ phase: "llm", line: "Config settled." });
      } catch (e) {
        onEvent({ phase: "llm", line: "Settle pass skipped: " + (e instanceof Error ? e.message : String(e)) });
      }
    }
    onEvent({ phase: "done", line: "Bootstrap complete.", openclawBin });
    return { ok: true, openclawBin };
  } catch (err) {
    onEvent({ phase: "error", line: err instanceof Error ? err.message : String(err) });
    throw err;
  }
});

ipcMain.handle("controller:get-setup-info", async () => getLocalSetupInfo());
// #223 W1: both handlers used to pass arbitrary renderer strings straight to
// the OS (file:// and custom-protocol handlers included). openExternal now
// only ever opens http(s) URLs; openPath only absolute local paths.
ipcMain.handle("shell:openExternal", async (_event, url) => {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("openExternal refused a non-URL target");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`openExternal refused non-http(s) target: ${parsed.protocol}`);
  }
  await shell.openExternal(parsed.href);
});

// openPath input gate (pure function, extracted for tests). Windows
// drive-letter forms (C:\x, D:/x) and UNC paths (\\server\share) ARE absolute
// local paths: the original scheme regex /^[a-z][a-z0-9+.-]*:/i misread the
// single-letter drive as a URL scheme and broke "open project in Explorer"
// on Windows (cross-review finding). Returns null when acceptable, else the
// rejection message.
function openPathRejection(raw) {
  if (path.win32.isAbsolute(raw)) {
    return null; // C:\x, C:/x, \\server\share ("C:relative" is drive-relative, not absolute)
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return "openPath expects a local path, not a URL";
  }
  if (!path.isAbsolute(raw)) {
    return "openPath expects an absolute path";
  }
  return null;
}

ipcMain.handle("shell:openPath", async (_event, targetPath) => {
  const raw = String(targetPath || "");
  const rejection = openPathRejection(raw);
  if (rejection) {
    throw new Error(rejection);
  }
  const result = await shell.openPath(raw);
  if (result) {
    throw new Error(result);
  }
  return { ok: true };
});
ipcMain.handle("notification:show", async (_event, payload) => {
  const title = String(payload?.title || "TeamClaw");
  const body = String(payload?.body || "");
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});
