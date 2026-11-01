import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * GitHub (GitHub App) user login for the TeamClaw controller.
 *
 * Flow: OAuth authorization code + PKCE (S256) + `state` CSRF guard, with a
 * localhost redirect handled by the controller HTTP server. See GITHUB_AUTH.md
 * for the full design.
 *
 * Persistence: a single JSON file under the plugin state directory
 * (`auth/github.json`, mode 0600, atomic tmp+rename writes).
 */

export const DEFAULT_GITHUB_CLIENT_ID = "Iv23liqWmzrS3swGiIvK";
export const GITHUB_AUTH_CALLBACK_PATH = "/api/v1/auth/github/callback";
export const GITHUB_CLIENT_SECRET_ENV = "TEAMCLAW_GITHUB_CLIENT_SECRET";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "teamclaw-github-auth";

const STORE_VERSION = 1;
/** Pending authorize flows older than this are discarded (CSRF window). */
const PENDING_FLOW_TTL_MS = 10 * 60 * 1000;
/** Refresh this long before the access token actually expires. */
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15 * 1000;

export class GithubAuthError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "GithubAuthError";
    this.code = code;
  }
}

export type GithubAccountInfo = {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
};

export type GithubAuthStore = {
  version: number;
  clientId: string;
  /** Which OAuth flow produced this token; device-flow tokens refresh without a client secret. */
  flowOrigin: "device" | "web";
  account: GithubAccountInfo | null;
  accessToken: string;
  refreshToken: string | null;
  obtainedAt: number;
  /** Epoch ms when the access token expires; null when it does not expire. */
  expiresAt: number | null;
  /** Epoch ms when the refresh token expires; null when unknown. */
  refreshExpiresAt: number | null;
  updatedAt: number;
};

export type GithubAuthStatus = {
  authenticated: boolean;
  account: GithubAccountInfo | null;
  clientId: string;
  clientSecretConfigured: boolean;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  callbackPath: string;
  callbackUrl: string | null;
  /** Absolute URL of the standalone device-login page, when origin is known. */
  loginPageUrl: string | null;
  /** Active device-flow login (user code to enter at github.com/login/device), if any. */
  device: GithubDeviceFlowInfo | null;
};

export type GithubDeviceFlowInfo = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalMs: number;
};

export type GithubLoginStart = {
  authorizeUrl: string;
  state: string;
  callbackUrl: string;
};

export type GithubLoginCallbackParams = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

export type GithubAuthLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

type GithubHttpResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type GithubFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<GithubHttpResponse>;

const defaultFetch: GithubFetch = (url, init) => fetch(url, init);

/** Location of the persisted token file, mirroring state.ts state-dir resolution. */
export function resolveGithubAuthFilePath(): string {
  const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) {
    return path.join(path.resolve(explicitStateDir), "plugins", "teamclaw", "auth", "github.json");
  }
  const explicitHome = process.env.OPENCLAW_HOME?.trim() || process.env.HOME?.trim();
  const homeDir = explicitHome ? path.resolve(explicitHome) : os.homedir();
  return path.join(homeDir, ".openclaw", "plugins", "teamclaw", "auth", "github.json");
}

const storeWriteQueues = new Map<string, Promise<void>>();

async function writeStoreAtomically(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, contents, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(tmpPath, 0o600);
  } catch {
    // Best-effort: the write itself already requested mode 0600; some
    // filesystems (e.g. network mounts) reject explicit chmod.
  }
  await fs.rename(tmpPath, filePath);
}

function enqueueStoreWrite(filePath: string, record: GithubAuthStore): Promise<void> {
  const contents = JSON.stringify(record, null, 2) + "\n";
  const previous = storeWriteQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeStoreAtomically(filePath, contents));
  storeWriteQueues.set(filePath, next);
  return next.finally(() => {
    if (storeWriteQueues.get(filePath) === next) {
      storeWriteQueues.delete(filePath);
    }
  });
}

async function postTokenRequest(
  fetchImpl: GithubFetch,
  params: Record<string, string>,
  options: { tolerateError?: boolean } = {},
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": GITHUB_USER_AGENT,
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  // Device-flow polling reports authorization_pending / slow_down as an
  // `error` field on HTTP 200; callers opt in to receiving those payloads.
  if (!options.tolerateError && (!response.ok || typeof payload.error === "string")) {
    const errorName = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    const description = typeof payload.error_description === "string" ? payload.error_description : "";
    throw new GithubAuthError(
      `GitHub token endpoint rejected the request (${errorName})${description ? `: ${description}` : ""}`,
      errorName,
    );
  }
  return payload;
}

export function createGithubAuthManager(options: {
  clientId?: string;
  clientSecret?: string;
  logger?: GithubAuthLogger;
  fetchImpl?: GithubFetch;
  now?: () => number;
} = {}) {
  const clientId = options.clientId?.trim() || DEFAULT_GITHUB_CLIENT_ID;
  // The environment variable wins so operators can keep the secret out of the
  // plugin config file.
  const clientSecret = process.env[GITHUB_CLIENT_SECRET_ENV]?.trim() || options.clientSecret?.trim() || "";
  const logger = options.logger;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const now = options.now ?? Date.now;
  const filePath = resolveGithubAuthFilePath();

  const pendingFlows = new Map<string, { createdAt: number; codeVerifier: string; redirectUri: string }>();
  let inFlightRefresh: Promise<GithubAuthStore> | null = null;
  let activeDeviceFlow: (GithubDeviceFlowInfo & { deviceCode: string }) | null = null;
  let devicePollTimer: NodeJS.Timeout | null = null;

  function requireSecret(): void {
    if (!clientSecret) {
      throw new GithubAuthError(
        `GitHub client secret is not configured. Generate one in the GitHub App settings and provide it via the ${GITHUB_CLIENT_SECRET_ENV} environment variable or the githubClientSecret plugin config.`,
        "missing_client_secret",
      );
    }
  }

  function beginLogin(origin: string): GithubLoginStart {
    requireSecret();
    const base = origin.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/.test(base)) {
      throw new GithubAuthError("Invalid controller origin for the GitHub login redirect.", "invalid_origin");
    }
    const callbackUrl = base + GITHUB_AUTH_CALLBACK_PATH;
    const state = crypto.randomBytes(24).toString("base64url");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const cutoff = now() - PENDING_FLOW_TTL_MS;
    for (const [key, flow] of pendingFlows) {
      if (flow.createdAt < cutoff) {
        pendingFlows.delete(key);
      }
    }
    pendingFlows.set(state, { createdAt: now(), codeVerifier, redirectUri: callbackUrl });

    const authorizeUrl = `${GITHUB_AUTHORIZE_URL}?${new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      // For GitHub Apps, offline_access is the only supported scope and is
      // what yields an expiring access token plus a refresh token.
      scope: "offline_access",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString()}`;

    return { authorizeUrl, state, callbackUrl };
  }

  function stopDeviceFlow(): void {
    if (devicePollTimer) {
      clearTimeout(devicePollTimer);
      devicePollTimer = null;
    }
    activeDeviceFlow = null;
  }

  function scheduleDevicePoll(delayMs: number): void {
    if (devicePollTimer) {
      clearTimeout(devicePollTimer);
    }
    devicePollTimer = setTimeout(() => {
      void pollDeviceFlowTick();
    }, Math.max(0, delayMs));
    devicePollTimer.unref?.();
  }

  /**
   * Start a device-flow login. No client secret is required: the device code
   * request and the token polling both send only the client id, and GitHub
   * allows refreshing device-flow tokens without a secret as well.
   */
  async function beginDeviceLogin(): Promise<GithubDeviceFlowInfo> {
    stopDeviceFlow();
    const response = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": GITHUB_USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: clientId,
        // Yields an expiring access token plus a refresh token; refresh of
        // device-flow tokens stays secretless.
        scope: "offline_access",
      }).toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    if (!response.ok || typeof data.error === "string") {
      const errorName = typeof data.error === "string" ? data.error : `http_${response.status}`;
      const hint = errorName === "device_flow_disabled"
        ? "Device flow is disabled for this GitHub App. Open the GitHub App settings and check 'Enable Device Flow'."
        : "";
      throw new GithubAuthError(
        `GitHub device authorization failed (${errorName})${hint ? `: ${hint}` : ""}`,
        errorName,
      );
    }
    const deviceCode = typeof data.device_code === "string" ? data.device_code : "";
    const userCode = typeof data.user_code === "string" ? data.user_code : "";
    const verificationUri = typeof data.verification_uri === "string"
      ? data.verification_uri
      : "https://github.com/login/device";
    if (!deviceCode || !userCode) {
      throw new GithubAuthError("GitHub device authorization response was missing device_code/user_code.", "device_code_invalid");
    }
    const expiresInSeconds = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 900;
    const intervalMs = (typeof data.interval === "number" && data.interval > 0 ? data.interval : 5) * 1000;
    activeDeviceFlow = {
      userCode,
      deviceCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expiresAt: now() + expiresInSeconds * 1000,
      intervalMs,
    };
    logger?.info(`Controller: GitHub device login started (code ${userCode})`);
    scheduleDevicePoll(intervalMs);
    const { deviceCode: _omit, ...info } = activeDeviceFlow;
    return info;
  }

  async function pollDeviceFlowTick(): Promise<void> {
    const flow = activeDeviceFlow;
    if (!flow) {
      return;
    }
    if (now() >= flow.expiresAt) {
      logger?.warn("Controller: GitHub device login expired before authorization");
      stopDeviceFlow();
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = await postTokenRequest(fetchImpl, {
        client_id: clientId,
        device_code: flow.deviceCode,
        grant_type: GITHUB_DEVICE_GRANT_TYPE,
      }, { tolerateError: true });
    } catch (err) {
      logger?.warn(`Controller: GitHub device poll failed (${err instanceof Error ? err.message : String(err)}); retrying`);
      scheduleDevicePoll(flow.intervalMs);
      return;
    }
    const errorCode = typeof payload.error === "string" ? payload.error : "";
    if (errorCode === "authorization_pending") {
      scheduleDevicePoll(flow.intervalMs);
      return;
    }
    if (errorCode === "slow_down") {
      flow.intervalMs += 5000;
      scheduleDevicePoll(flow.intervalMs);
      return;
    }
    if (errorCode) {
      // expired_token / access_denied / incorrect_device_code / device_flow_disabled
      logger?.warn(`Controller: GitHub device login ended (${errorCode})`);
      stopDeviceFlow();
      return;
    }
    try {
      await persistTokenExchange(payload, "device");
    } catch (err) {
      logger?.warn(`Controller: GitHub device login completion failed (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      stopDeviceFlow();
    }
  }

  async function fetchAccount(accessToken: string): Promise<GithubAccountInfo> {
    const response = await fetchImpl(`${GITHUB_API_BASE}/user`, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": GITHUB_USER_AGENT,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new GithubAuthError(`Failed to load the GitHub user profile (HTTP ${response.status}).`, "user_profile_failed");
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const id = typeof payload.id === "number" ? payload.id : Number(payload.id);
    const login = typeof payload.login === "string" ? payload.login : "";
    if (!Number.isFinite(id) || !login) {
      throw new GithubAuthError("GitHub user profile response was missing id/login.", "user_profile_invalid");
    }
    return {
      id,
      login,
      name: typeof payload.name === "string" ? payload.name : null,
      avatarUrl: typeof payload.avatar_url === "string" ? payload.avatar_url : null,
      htmlUrl: typeof payload.html_url === "string" ? payload.html_url : null,
    };
  }

  async function loadStore(): Promise<GithubAuthStore | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
        return null;
      }
      const account = parsed.account && typeof parsed.account === "object" && !Array.isArray(parsed.account)
        ? parsed.account as Record<string, unknown>
        : null;
      return {
        version: typeof parsed.version === "number" ? parsed.version : STORE_VERSION,
        clientId: typeof parsed.clientId === "string" ? parsed.clientId : clientId,
        flowOrigin: parsed.flowOrigin === "device" ? "device" : "web",
        account: account && typeof account.login === "string"
          ? {
              id: typeof account.id === "number" ? account.id : 0,
              login: account.login,
              name: typeof account.name === "string" ? account.name : null,
              avatarUrl: typeof account.avatarUrl === "string" ? account.avatarUrl : null,
              htmlUrl: typeof account.htmlUrl === "string" ? account.htmlUrl : null,
            }
          : null,
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
        obtainedAt: typeof parsed.obtainedAt === "number" ? parsed.obtainedAt : 0,
        expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
        refreshExpiresAt: typeof parsed.refreshExpiresAt === "number" ? parsed.refreshExpiresAt : null,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      };
    } catch {
      // Missing or unreadable file simply means "not signed in yet".
      return null;
    }
  }

  async function clearStore(): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // Already absent — nothing to clear.
    }
  }

  async function performRefresh(store: GithubAuthStore): Promise<GithubAuthStore> {
    if (!store.refreshToken) {
      await clearStore();
      throw new GithubAuthError("GitHub login has no refresh token; sign in again.", "refresh_unavailable");
    }
    const refreshParams: Record<string, string> = {
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: store.refreshToken,
    };
    if (clientSecret) {
      refreshParams.client_secret = clientSecret;
    } else if (store.flowOrigin !== "device") {
      // GitHub: client_secret is required for refresh UNLESS the token came
      // from the device flow. Secretless installs must therefore log in via
      // the device flow (the default).
      await clearStore();
      throw new GithubAuthError(
        `Refreshing this GitHub login requires the client secret. Sign in again using the device flow (default), which refreshes without a secret, or configure ${GITHUB_CLIENT_SECRET_ENV}.`,
        "missing_client_secret",
      );
    }
    let payload: Record<string, unknown>;
    try {
      payload = await postTokenRequest(fetchImpl, refreshParams);
    } catch (err) {
      if (err instanceof GithubAuthError && err.code === "bad_refresh_token") {
        // The refresh token is dead (expired or revoked): drop the stored
        // credentials so the UI falls back to "not signed in".
        await clearStore();
        throw new GithubAuthError("GitHub login has expired; sign in again.", "refresh_expired");
      }
      throw err;
    }
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!accessToken) {
      throw new GithubAuthError("GitHub refresh response did not include an access token.", "missing_access_token");
    }
    const refreshedAt = now();
    const next: GithubAuthStore = {
      ...store,
      accessToken,
      // Refresh tokens rotate: always prefer the newly issued one.
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : store.refreshToken,
      expiresAt: typeof payload.expires_in === "number" ? refreshedAt + payload.expires_in * 1000 : null,
      refreshExpiresAt: typeof payload.refresh_token_expires_in === "number"
        ? refreshedAt + payload.refresh_token_expires_in * 1000
        : store.refreshExpiresAt,
      updatedAt: refreshedAt,
    };
    await enqueueStoreWrite(filePath, next);
    logger?.info("Controller: GitHub access token refreshed");
    return next;
  }

  async function persistTokenExchange(payload: Record<string, unknown>, flowOrigin: "device" | "web"): Promise<GithubAccountInfo> {
    const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
    if (!accessToken) {
      throw new GithubAuthError("GitHub token response did not include an access token.", "missing_access_token");
    }
    const account = await fetchAccount(accessToken);
    const fetchedAt = now();
    await enqueueStoreWrite(filePath, {
      version: STORE_VERSION,
      clientId,
      flowOrigin,
      account,
      accessToken,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
      obtainedAt: fetchedAt,
      expiresAt: typeof payload.expires_in === "number" ? fetchedAt + payload.expires_in * 1000 : null,
      refreshExpiresAt: typeof payload.refresh_token_expires_in === "number"
        ? fetchedAt + payload.refresh_token_expires_in * 1000
        : null,
      updatedAt: fetchedAt,
    });
    logger?.info(`Controller: GitHub login stored for @${account.login}`);
    return account;
  }

  async function completeLogin(params: GithubLoginCallbackParams): Promise<GithubAccountInfo> {
    if (params.error) {
      throw new GithubAuthError(
        `GitHub authorization was not granted (${params.error}${params.errorDescription ? `: ${params.errorDescription}` : ""}).`,
        params.error,
      );
    }
    const state = params.state ?? "";
    const code = params.code ?? "";
    const flow = pendingFlows.get(state);
    // One-shot: a state value can only ever be consumed once.
    pendingFlows.delete(state);
    if (!flow) {
      throw new GithubAuthError("Unknown or already-used GitHub login state. Please start the login again.", "invalid_state");
    }
    if (now() - flow.createdAt > PENDING_FLOW_TTL_MS) {
      throw new GithubAuthError("GitHub login state expired. Please start the login again.", "state_expired");
    }
    if (!code) {
      throw new GithubAuthError("GitHub login callback is missing the authorization code.", "missing_code");
    }
    requireSecret();

    const payload = await postTokenRequest(fetchImpl, {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.codeVerifier,
    });
    return persistTokenExchange(payload, "web");
  }

  async function getAccessToken(): Promise<string> {
    const store = await loadStore();
    if (!store) {
      throw new GithubAuthError("Not signed in to GitHub.", "not_authenticated");
    }
    if (store.expiresAt === null || now() < store.expiresAt - REFRESH_EARLY_MS) {
      return store.accessToken;
    }
    // Single-flight: concurrent callers share one refresh round-trip.
    const refreshed = inFlightRefresh ?? (inFlightRefresh = performRefresh(store).finally(() => {
      inFlightRefresh = null;
    }));
    return (await refreshed).accessToken;
  }

  async function forceRefresh(): Promise<GithubAuthStore> {
    const store = await loadStore();
    if (!store) {
      throw new GithubAuthError("Not signed in to GitHub.", "not_authenticated");
    }
    return performRefresh(store);
  }

  async function logout(): Promise<void> {
    const store = await loadStore();
    if (store && clientSecret) {
      try {
        const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        await fetchImpl(`${GITHUB_API_BASE}/applications/${clientId}/token`, {
          method: "DELETE",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Basic ${basic}`,
            "Content-Type": "application/json",
            "User-Agent": GITHUB_USER_AGENT,
          },
          body: JSON.stringify({ access_token: store.accessToken }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (err) {
        logger?.warn(`Controller: GitHub token revocation skipped (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    await clearStore();
    pendingFlows.clear();
    stopDeviceFlow();
  }

  async function getStatus(origin?: string): Promise<GithubAuthStatus> {
    const store = await loadStore();
    return {
      authenticated: store !== null,
      account: store?.account ?? null,
      clientId,
      clientSecretConfigured: Boolean(clientSecret),
      expiresAt: store?.expiresAt ?? null,
      refreshExpiresAt: store?.refreshExpiresAt ?? null,
      callbackPath: GITHUB_AUTH_CALLBACK_PATH,
      callbackUrl: origin
        ? origin.trim().replace(/\/+$/, "") + GITHUB_AUTH_CALLBACK_PATH
        : null,
      loginPageUrl: origin
        ? origin.trim().replace(/\/+$/, "") + "/ui/auth/github"
        : null,
      device: activeDeviceFlow
        ? {
            userCode: activeDeviceFlow.userCode,
            verificationUri: activeDeviceFlow.verificationUri,
            verificationUriComplete: activeDeviceFlow.verificationUriComplete,
            expiresAt: activeDeviceFlow.expiresAt,
            intervalMs: activeDeviceFlow.intervalMs,
          }
        : null,
    };
  }

  /** Ready-to-use GitHub API headers for internal consumers of the stored token. */
  async function getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": GITHUB_USER_AGENT,
    };
  }

  return {
    beginLogin,
    beginDeviceLogin,
    completeLogin,
    getAccessToken,
    getAuthHeaders,
    getStatus,
    forceRefresh,
    logout,
  };
}

export type GithubAuthManager = ReturnType<typeof createGithubAuthManager>;

const managerCache = new Map<string, GithubAuthManager>();

/**
 * Cached manager keyed by client id, secret, and token file location so the
 * controller's in-memory pending-flow state survives across requests.
 */
export function getGithubAuthManager(
  config: { githubClientId?: string; githubClientSecret?: string },
  logger?: GithubAuthLogger,
): GithubAuthManager {
  const clientId = config.githubClientId?.trim() || DEFAULT_GITHUB_CLIENT_ID;
  const clientSecret = config.githubClientSecret ?? "";
  const cacheKey = [
    clientId,
    crypto.createHash("sha256").update(clientSecret).digest("hex").slice(0, 16),
    resolveGithubAuthFilePath(),
  ].join("|");
  const cached = managerCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const manager = createGithubAuthManager({ clientId, clientSecret, logger });
  managerCache.set(cacheKey, manager);
  return manager;
}
