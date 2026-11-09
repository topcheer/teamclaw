// Shared contracts layer (issue #226, W5): the GitHub auth manager TYPE
// contract. The teamauto subsystem consumes this type (github-client,
// scheduler, repo-sync all take a GithubAuthManager), so the cross-subsystem
// contract lives here — teamauto must not import the controller tree. Only
// types moved; the factory (createGithubAuthManager) and the singleton cache
// (getGithubAuthManager) stay in controller/github-auth.ts, which annotates
// the factory's return type with this contract so the compiler keeps the
// structural definition in lockstep with the implementation.
//
// GithubAuthManager was previously `ReturnType<typeof createGithubAuthManager>`;
// the explicit structural form below is signature-identical (each member
// mirrors one returned closure verbatim) and no longer requires importing the
// controller factory to name the type.

/** GitHub account profile loaded from /user at login time. */
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

export type GithubDeviceFlowInfo = {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
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

/**
 * The manager surface created by controller/github-auth.ts's
 * createGithubAuthManager. Consumers (teamauto, controller routes) depend
 * only on this shape.
 */
export type GithubAuthManager = {
  beginLogin: (origin: string) => GithubLoginStart;
  beginDeviceLogin: () => Promise<GithubDeviceFlowInfo>;
  completeLogin: (params: GithubLoginCallbackParams) => Promise<GithubAccountInfo>;
  getAccessToken: () => Promise<string>;
  getAuthHeaders: () => Promise<Record<string, string>>;
  getStatus: (origin?: string) => Promise<GithubAuthStatus>;
  forceRefresh: () => Promise<GithubAuthStore>;
  logout: () => Promise<void>;
};
