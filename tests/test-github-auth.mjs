#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const githubAuthPath = path.join(projectRoot, "src", "src", "controller", "github-auth.ts");
const httpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");
const typesPath = path.join(projectRoot, "src", "src", "types.ts");
const configPath = path.join(projectRoot, "src", "src", "config.ts");
const uiAppPath = path.join(projectRoot, "src", "src", "ui", "app.js");
const desktopAppPath = path.join(projectRoot, "desktop", "renderer", "app.js");

async function runGithubAuthSmoke() {
  const [githubAuthSource, httpServerSource, typesSource, configSource, uiAppSource, desktopAppSource] = await Promise.all([
    fs.readFile(githubAuthPath, "utf8"),
    fs.readFile(httpServerPath, "utf8"),
    fs.readFile(typesPath, "utf8"),
    fs.readFile(configPath, "utf8"),
    fs.readFile(uiAppPath, "utf8"),
    fs.readFile(desktopAppPath, "utf8"),
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

  // UI surfaces (web + desktop).
  assert.match(uiAppSource, /\/auth\/github\/login/, "web UI must start GitHub login");
  assert.match(uiAppSource, /\/auth\/github\/status/, "web UI must render GitHub login status");
  assert.match(uiAppSource, /\/auth\/github\/logout/, "web UI must support GitHub sign-out");
  assert.match(uiAppSource, /verificationUriComplete/, "web UI must offer the prefilled device verification URL");
  assert.match(desktopAppSource, /verificationUriComplete/, "desktop facade must offer the prefilled device verification URL");
  assert.match(desktopAppSource, /openExternal/, "desktop facade must open the authorize URL in the system browser");

  console.log("test-github-auth: ok");
}

runGithubAuthSmoke().catch((err) => {
  console.error("test-github-auth failed:", err);
  process.exit(1);
});
