#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const githubAuthPath = path.join(projectRoot, "src", "src", "controller", "github-auth.ts");
const githubLoginPagePath = path.join(projectRoot, "src", "src", "ui", "github-login.html");
const httpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const typesPath = path.join(projectRoot, "src", "src", "types.ts");
const configPath = path.join(projectRoot, "src", "src", "config.ts");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const uiHtmlPath = path.join(projectRoot, "src", "src", "ui", "index.html");
const desktopAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");

async function runGithubAuthSmoke() {
  const [githubAuthSource, httpServerSource, typesSource, configSource, uiAppSource, desktopAppSource, githubLoginPageSource] = await Promise.all([
    fs.readFile(githubAuthPath, "utf8"),
    fs.readFile(httpServerPath, "utf8"),
    fs.readFile(typesPath, "utf8"),
    fs.readFile(configPath, "utf8"),
    fs.readFile(uiAppPath, "utf8"),
    fs.readFile(desktopAppPath, "utf8"),
    fs.readFile(githubLoginPagePath, "utf8"),
  ]);

  // Client ID + callback path constants ship with the plugin.
  assert.match(
    githubAuthSource,
    /export const DEFAULT_GITHUB_CLIENT_ID = "Iv23liqWmzrS3swGiIvK"/,
    "GitHub OAuth client ID must default to the registered TeamClaw GitHub App",
  );
  assert.match(
    githubAuthSource,
    /export const GITHUB_AUTH_CALLBACK_PATH = "\/api\/v1\/auth\/github\/callback"/,
    "GitHub login must use a stable localhost callback path",
  );

  // Flow mechanics: PKCE S256 + state CSRF window + offline_access refresh tokens.
  assert.match(githubAuthSource, /code_challenge_method: "S256"/, "GitHub login must use PKCE S256");
  assert.match(githubAuthSource, /scope: "offline_access"/, "GitHub login must request offline_access to receive refresh tokens");
  assert.match(githubAuthSource, /grant_type: "refresh_token"/, "stored refresh tokens must be redeemable");
  assert.match(githubAuthSource, /code_verifier/, "token exchange must present the PKCE verifier");
  assert.match(githubAuthSource, /PENDING_FLOW_TTL_MS/, "login state must have a CSRF TTL");
  assert.match(githubAuthSource, /TEAMCLAW_GITHUB_CLIENT_SECRET/, "client secret must be injectable via env");

  // Device flow (default, secretless): device code request + polling + secretless refresh.
  assert.match(
    githubAuthSource,
    /GITHUB_DEVICE_CODE_URL = "https:\/\/github\.com\/login\/device\/code"/,
    "device flow must POST to github.com/login/device/code",
  );
  assert.match(
    githubAuthSource,
    /urn:ietf:params:oauth:grant-type:device_code/,
    "device-flow token polling must use the device_code grant type (client_id only, no secret)",
  );
  assert.match(githubAuthSource, /authorization_pending/, "device polling must keep waiting on authorization_pending");
  assert.match(githubAuthSource, /slow_down/, "device polling must honor slow_down backoff (+5s)");
  assert.match(githubAuthSource, /flowOrigin/, "persisted tokens must record flow origin for secretless refresh");
  assert.match(
    githubAuthSource,
    /store\.flowOrigin !== "device"/,
    "refresh must only demand a client secret for web-flow tokens",
  );
  assert.match(httpServerSource, /beginDeviceLogin\(\)/, "login endpoint must default to the device flow");
  assert.match(
    httpServerSource,
    /pathname === "\/ui\/auth\/github"/,
    "controller must serve the standalone GitHub login page",
  );
  assert.match(
    githubAuthSource,
    /loginPageUrl/,
    "auth status must expose the standalone login page URL",
  );

  // Standalone device-login page: big code + prefilled link + polling, no secret nagging.
  assert.match(githubLoginPageSource, /device-code/, "login page must render the device user code");
  assert.match(githubLoginPageSource, /openBtn\.href = device\.verificationUri;/, "login page must link the plain device verification URL (GitHub does not support user_code prefill)");
  assert.ok(!githubLoginPageSource.includes("verificationUriComplete"), "the login page must not use a synthesized prefill URL");
  assert.match(githubLoginPageSource, /\/api\/v1\/auth\/github/, "login page must drive the auth endpoints");
  assert.match(githubLoginPageSource, /"\/status"/, "login page must poll the auth status endpoint");
  assert.ok(!githubLoginPageSource.includes("client_secret"), "login page must never mention client secrets");

  // Persistence: plugin state dir + 0600 + atomic rename.
  assert.match(githubAuthSource, /"plugins", "teamclaw", "auth", "github\.json"/, "tokens must live under the teamclaw plugin state dir");
  assert.match(githubAuthSource, /mode: 0o600/, "token file must be written with 0600 permissions");
  assert.match(githubAuthSource, /fs\.rename\(/, "token file writes must be atomic (tmp+rename)");

  // Controller endpoints.
  for (const route of [
    "/api/v1/auth/github/status",
    "/api/v1/auth/github/login",
    "/api/v1/auth/github/callback",
    "/api/v1/auth/github/logout",
    "/api/v1/auth/github/refresh",
  ]) {
    assert.ok(httpServerSource.includes(`pathname === "${route}"`), `controller must route ${route}`);
  }

  // Config surface.
  assert.match(typesSource, /githubClientId: string/, "PluginConfig must expose githubClientId");
  assert.match(typesSource, /githubClientSecret: string/, "PluginConfig must expose githubClientSecret");
  assert.match(configSource, /githubClientId: \{/, "config schema must document githubClientId");
  assert.match(configSource, /githubClientSecret: \{/, "config schema must document githubClientSecret");

  // UI surfaces (web + desktop): header-corner login/user chip + standalone page.
  assert.match(uiAppSource, /\/ui\/auth\/github/, "web UI must open the standalone GitHub login page");
  assert.match(uiAppSource, /github-corner-login/, "web UI must show a top-right login button");
  assert.match(uiAppSource, /github-corner-user/, "web UI must show the signed-in user chip in the corner");
  assert.match(uiAppSource, /\/auth\/github\/status/, "web UI must render GitHub login status");
  assert.match(uiAppSource, /\/auth\/github\/logout/, "web UI must support GitHub sign-out");
  assert.ok(!uiAppSource.includes("gh.noSecret"), "web UI must not nag about the client secret (device flow is secretless)");
  const uiHtmlSource = await fs.readFile(uiHtmlPath, "utf8");
  assert.ok(
    !/github-corner-login[^>]*\shidden/.test(uiHtmlSource),
    "the corner login button must be visible by default (JS toggles the hidden property, not a class)",
  );
  assert.match(desktopAppSource, /\/ui\/auth\/github/, "desktop facade must open the standalone GitHub login page");
  assert.match(desktopAppSource, /gh-corner-login/, "desktop facade must show a top-right login button");
  assert.match(desktopAppSource, /gh-corner-user/, "desktop facade must show the signed-in user chip in the corner");
  assert.ok(!desktopAppSource.includes("ctl.gh.noSecret"), "desktop facade must not nag about the client secret");

  console.log("test-github-auth: ok");
}

/**
 * Runs the standalone login page's inline script against a stub DOM that
 * faithfully models textContent-destroys-children, then asserts the device
 * view becomes visible and the fresh code is auto-copied. This exact scenario
 * (page stuck on the idle view because setCountdown threw) regressed before.
 */
async function runLoginPageRuntimeSmoke() {
  const html = await fs.readFile(githubLoginPagePath, "utf8");
  assert.match(html, /id="t-expires-label"/, "the countdown label must be its own span");
  assert.ok(!/\$\("t-expires"\)\.textContent = ""/.test(html), "init must not wipe the countdown node");
  assert.match(html, /id="copy-state"/, "the page must show a copy status indicator");
  assert.match(html, /navigator\.clipboard\.writeText/, "the page must copy via the async clipboard API");
  assert.match(html, /showDevice\(result\.body, true\)/, "the sign-in click must render the code and gesture-chain the copy");
  assert.ok(!html.includes("window.open"), "the page must never auto-navigate to GitHub; the user clicks the open button");
  assert.match(html, /showDevice\(status\.device, false\)/, "background polling must display without clipboard attempts");

  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, "the login page must embed its script inline");

  const ids = [
    "app", "view-loading", "view-idle", "view-device", "view-success", "t-loading",
    "t-idle-title", "t-idle-sub", "btn-start", "idle-error", "t-device-title", "t-device-sub",
    "device-code", "copy-state", "btn-copy", "t-expires", "t-expires-label", "countdown",
    "btn-open", "t-waiting", "ok-badge", "t-success-title", "account-avatar", "account-login",
    "account-meta", "btn-logout", "t-close",
  ];
  const registry = new Map();
  function makeEl(id) {
    const el = {
      id, _text: "", _children: [], detached: false, hidden: false, href: "", src: "",
      disabled: false, value: "", style: {}, _handlers: {},
      addEventListener(type, fn) { this._handlers[type] = fn; }, select() {},
      appendChild(child) { child.detached = false; this._children.push(child); this._text = ""; },
      removeChild(child) { this._children = this._children.filter((c) => c !== child); },
    };
    Object.defineProperty(el, "classList", {
      value: {
        add: (c) => el._classes.add(c),
        remove: (c) => el._classes.delete(c),
        contains: (c) => el._classes.has(c),
        toggle: (c, force) => {
          if (force === undefined) { el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c); }
          else if (force) { el._classes.add(c); } else { el._classes.delete(c); }
        },
      },
    });
    el._classes = new Set();
    Object.defineProperty(el, "textContent", {
      get() { return this._text + this._children.map((c) => c.textContent).join(""); },
      set(v) {
        this._text = String(v);
        for (const c of this._children) { c.detached = true; }
        this._children = [];
      },
    });
    return el;
  }
  for (const id of ids) { registry.set(id, makeEl(id)); }
  registry.get("t-expires").appendChild(registry.get("countdown"));

  const clipboardWrites = [];
  const windowOpens = [];
  let fetchCalls = 0;
  const deviceBody = {
    mode: "device",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresAt: Date.now() + 900_000,
    intervalMs: 5000,
  };
  const documentStub = {
    getElementById: (id) => { const el = registry.get(id); return el && !el.detached ? el : null; },
    createElement: () => makeEl("tmp"),
    body: makeEl("body"),
  };
  const deviceStatus = { authenticated: false, account: null, device: deviceBody };
  const pageScript = new Function(
    "document", "navigator", "window", "fetch", "setInterval", "clearInterval", "setTimeout",
    scriptMatch[1],
  );
  pageScript(
    documentStub,
    { language: "en-US", clipboard: { writeText: (v) => { clipboardWrites.push(v); return Promise.resolve(); } } },
    { open: (...args) => { windowOpens.push(args); } },
    (url) => {
      fetchCalls++;
      const body = String(url).endsWith("/login") ? deviceBody : deviceStatus;
      return Promise.resolve({ ok: true, json: async () => body });
    },
    () => 0, () => {}, () => 0,
  );
  // Initial status poll settles WITHOUT any clipboard write (no user gesture).
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clipboardWrites, [], "background polling must not touch the clipboard");

  // Step 1: the sign-in click fetches the code, renders it, and copies in-chain.
  assert.ok(registry.get("btn-start")._handlers.click, "btn-start must be wired");
  await registry.get("btn-start")._handlers.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(
    !registry.get("view-device")._classes.has("hidden"),
    "the device view must become visible once a login flow is active",
  );
  assert.equal(registry.get("device-code").textContent, "WDJB-MJHT");
  assert.match(registry.get("countdown").textContent, /^\d\d:\d\d$/, "the countdown must render mm:ss");
  assert.deepEqual(clipboardWrites, ["WDJB-MJHT"], "the click chain must copy the fresh code to the clipboard");
  assert.deepEqual(windowOpens, [], "clicking sign-in must NOT navigate to GitHub");
  assert.equal(registry.get("btn-open").href, deviceBody.verificationUri);
  assert.ok(
    !registry.get("copy-state")._classes.has("hidden"),
    "the copy status indicator must be visible after the copy attempt",
  );
}

(async () => {
  await runGithubAuthSmoke();
  await runLoginPageRuntimeSmoke();
  console.log("test-github-auth: ok (incl. login page runtime)");
})().catch((err) => {
  console.error("test-github-auth failed:", err);
  process.exit(1);
});
