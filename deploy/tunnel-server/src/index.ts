/**
 * TeamClaw Tunnel Server (Cloudflare Worker)
 *
 * Provisions per-user Cloudflare Tunnels so local TeamClaw web UIs can be
 * shared at <github_user>.apps.teamclaw.dev. Visitor gating (the random
 * token shown in the local web UI) is enforced locally by each user's
 * controller, not here.
 *
 * Env secrets:
 *   CF_API_TOKEN  - least-privilege: Account.Cloudflare Tunnel:Edit + Zone.DNS:Edit (teamclaw.dev)
 *   CF_ACCOUNT_ID - account owning the tunnels
 *   CF_ZONE_ID    - zone id of teamclaw.dev (DNS records)
 *
 * Env vars:
 *   ACCEPT_LEGACY_CREATE - issue #231 grey window: "true"/unset passes
 *     headerless creates (pre-#231 controllers) with a console.warn;
 *     "false" requires Authorization: Bearer proving github_user ownership.
 */

const USER_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const MAX_TUNNELS_PER_USER = 1;
const GLOBAL_WATERMARK = 800; // refuse new tunnels past this to protect the account limit (1000)
const TUNNEL_PREFIX = "teamclaw-tunnel-";
const DOMAIN = "teamclaw.dev";

interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  WORKER_SIGNING_KEY?: string; // HMAC secret: per-tunnel delete tokens
  // Issue #231 grey window: relay deploys before controllers send
  // Authorization on create. "true" (or unset) still passes headerless
  // creates (with a console.warn each, so convergence is observable in the
  // logs); "false" requires the github_user ownership proof.
  ACCEPT_LEGACY_CREATE?: string;
}

interface CfTunnel {
  id: string;
  name: string;
  status?: string;
  deleted_at?: string | null;
  token?: string;
}

function json(status: number, body: unknown): Response {
  // Issue #231: no Access-Control-Allow-* headers anymore. This management
  // API is called server-to-server by controllers (no Origin involved), and
  // browsers must not read these responses cross-origin — omitting ACAO is
  // the fail-closed default for exactly that.
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Best-effort per-IP limiter (per-isolate: Workers isolates are per-colo and
// ephemeral, so this blunts naive loops, not a distributed flood — the
// account watermark below stays the hard bound).
const rateBuckets = new Map<string, { n: number; reset: number }>();
function rateLimited(req: Request, max: number, windowMs: number): boolean {
  if (rateBuckets.size > 10000) rateBuckets.clear();
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const b = rateBuckets.get(ip);
  if (!b || b.reset < now) {
    rateBuckets.set(ip, { n: 1, reset: now + windowMs });
    return false;
  }
  b.n += 1;
  return b.n > max;
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function fixedEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Issue #231: POST /api/tunnels must prove the caller owns github_user — a
// squattable name would host phishing on team-<user>.teamclaw.dev and drain
// the 800-slot watermark. The proof is one GET /user made with the caller's
// OWN Bearer token: GitHub vouches the token belongs to that login. Cost is
// one GitHub API call per create, bounded by the 10/h/IP create rate limit
// that runs BEFORE this check (the verification must never be reachable
// unthrottled, or it would itself be a DoS amplifier).
const GITHUB_USER_TIMEOUT_MS = 10_000;
async function githubLoginFor(
  token: string,
): Promise<{ ok: true; login: string } | { ok: false; reason: string }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "teamclaw-tunnel-api",
      },
      signal: AbortSignal.timeout(GITHUB_USER_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `github /user http ${res.status}` };
    const data = (await res.json().catch(() => null)) as { login?: string } | null;
    if (!data || typeof data.login !== "string") {
      return { ok: false, reason: "github /user returned no login" };
    }
    return { ok: true, login: data.login };
  } catch (err) {
    return { ok: false, reason: `github /user failed: ${String(err)}` };
  }
}

// A tunnel is LIVE only while a connector is actually attached. The DNS CNAME
// (<tunnel-id>.cfargotunnel.com) makes tunnel ids publicly discoverable, so
// "live" — not merely existing — is what unauthenticated callers must not be
// able to disrupt.
async function tunnelLive(id: string, env: Env): Promise<boolean> {
  const cur = await cf(`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}`, { method: "GET" }, env);
  const t = cur.data as (CfTunnel & { connections?: unknown[] }) | null;
  return cur.ok && Array.isArray(t?.connections) && t.connections.length > 0;
}

function tunnelName(user: string): string {
  return `${TUNNEL_PREFIX}${user}`;
}

function hostnameFor(user: string): string {
  // One level deep (tunnel-<user>) so the free Universal SSL wildcard
  // *.teamclaw.dev covers it; <user>.apps.* is two levels and is NOT covered.
  return `team-${user}.${DOMAIN}`;
}

async function cf(path: string, init: RequestInit, env: Env): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: unknown };
  return { ok: res.ok && data.success !== false, status: res.status, data: data.result ?? data };
}

async function listActiveTunnels(env: Env): Promise<CfTunnel[]> {
  const r = await cf(`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel?is_deleted=false&per_page=1000`, { method: "GET" }, env);
  if (!Array.isArray(r.data)) return [];
  return (r.data as CfTunnel[]).filter((t) => t.name.startsWith(TUNNEL_PREFIX));
}

async function deleteDns(env: Env, user: string): Promise<void> {
  const name = hostnameFor(user);
  const r = await cf(`/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(name)}&per_page=5`, { method: "GET" }, env);
  const records = Array.isArray(r.data) ? (r.data as Array<{ id: string }>) : [];
  for (const rec of records) {
    await cf(`/zones/${env.CF_ZONE_ID}/dns_records/${rec.id}`, { method: "DELETE" }, env);
  }
}

async function teardownUserTunnels(env: Env, user: string): Promise<void> {
  const all = await listActiveTunnels(env);
  const mine = all.filter((t) => t.name === tunnelName(user));
  for (const t of mine) {
    await cf(`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${t.id}`, { method: "DELETE" }, env);
  }
  if (mine.length > 0) await deleteDns(env, user);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Issue #231: preflights are still answered (a clean 204 rather than
    // the 404 JSON), but with NO Access-Control-Allow-* headers — without
    // ACAO a browser preflight fails, which is the intended denial: the
    // wildcard CORS of the pre-#231 relay is gone and nothing replaces it.
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    if (url.pathname === "/api/health") {
      return json(200, {
        ok: true,
        configured: Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID),
        service: "teamclaw-tunnel-api",
      });
    }

    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID || !env.CF_ZONE_ID) {
      return json(503, { error: "server not configured (CF_API_TOKEN/CF_ACCOUNT_ID/CF_ZONE_ID)" });
    }

    if (req.method === "POST" && url.pathname === "/api/tunnels") {
      if (rateLimited(req, 10, 3600_000)) return json(429, { error: "rate limited (10 creates/hour/ip)" });
      const body = (await req.json().catch(() => ({}))) as { github_user?: string; local_port?: number };
      const user = String(body.github_user ?? "").trim().toLowerCase();
      if (!USER_RE.test(user)) return json(400, { error: "invalid github_user" });
      const port = Number(body.local_port) > 0 ? Math.floor(Number(body.local_port)) : 9527;

      // Issue #231: github_user ownership proof. Ordered deliberately:
      // AFTER the per-IP rate limit above (the upstream GitHub call stays
      // inside the 10/h create budget) and BEFORE any Cloudflare API work
      // below (unauthenticated probers learn nothing about existing
      // tunnels — not even the 409 live-tunnel signal — and cost the relay
      // zero CF calls).
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
      if (!bearer) {
        if (env.ACCEPT_LEGACY_CREATE === "false") {
          return json(401, { error: "authorization required: send Authorization: Bearer <github oauth token> proving github_user ownership" });
        }
        // Grey window: pre-#231 controllers create without a token. Warn on
        // each (no token material logged) so the console shows when legacy
        // traffic has stopped and ACCEPT_LEGACY_CREATE can flip to "false".
        console.warn("tunnel create without Authorization header (legacy controller); ACCEPT_LEGACY_CREATE defaults to true");
      } else {
        const gh = await githubLoginFor(bearer[1]!.trim());
        // Fail-closed as 401: GitHub-side failure (bad token, timeout, 5xx)
        // rejects the create, and probing callers cannot distinguish "relay
        // degraded" from "token bad" — while the reason above lands in the
        // logs for diagnosis.
        if (!gh.ok) return json(401, { error: "github_user ownership verification failed", detail: gh.reason });
        if (gh.login.toLowerCase() !== user) {
          return json(403, { error: `github_user "${user}" does not belong to the authenticated GitHub account` });
        }
      }

      try {
        // Replace semantics, hardened: an unauthenticated create must never
        // disrupt a LIVE share (attacker only needs the victim's github
        // name). Dead tunnels — e.g. after the owner's gateway restart —
        // stay freely replaceable so the re-share flow keeps working.
        const all = await listActiveTunnels(env);
        const mine = all.filter((t) => t.name === tunnelName(user));
        for (const t of mine) {
          if (await tunnelLive(t.id, env)) {
            return json(409, { error: "an active tunnel already exists for this user (stop sharing first)" });
          }
        }
        if (mine.length === 0 && all.length >= GLOBAL_WATERMARK) {
          return json(429, { error: "tunnel watermark reached, try again later" });
        }
        if (mine.length + 1 > MAX_TUNNELS_PER_USER) {
          await teardownUserTunnels(env, user);
        }

        // 1. Create a remotely-managed tunnel; the returned token is the connector token.
        const created = await cf(
          `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`,
          { method: "POST", body: JSON.stringify({ name: tunnelName(user), config_src: "cloudflare" }) },
          env,
        );
        if (!created.ok || !created.data) {
          return json(502, { error: "tunnel create failed", detail: created.data });
        }
        const tunnel = created.data as CfTunnel;
        const connectorToken = tunnel.token;
        if (!connectorToken) return json(502, { error: "tunnel create returned no connector token" });

        // 2. Ingress: the user's hostname routes to their local controller port.
        const hostname = hostnameFor(user);
        const cfg = await cf(
          `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}/configurations`,
          {
            method: "PUT",
            body: JSON.stringify({
              config: {
                ingress: [
                  { hostname, service: `http://localhost:${port}` },
                  { service: "http_status:404" },
                ],
              },
            }),
          },
          env,
        );
        if (!cfg.ok) {
          await cf(`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`, { method: "DELETE" }, env);
          return json(502, { error: "tunnel configuration failed", detail: cfg.data });
        }

        // 3. DNS: <user>.apps.teamclaw.dev -> <tunnel_id>.cfargotunnel.com (proxied).
        await deleteDns(env, user); // stale record from a previous run, if any
        const dns = await cf(
          `/zones/${env.CF_ZONE_ID}/dns_records`,
          {
            method: "POST",
            body: JSON.stringify({ type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true }),
          },
          env,
        );
        if (!dns.ok) {
          await cf(`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnel.id}`, { method: "DELETE" }, env);
          return json(502, { error: "dns record failed", detail: dns.data });
        }

        // Delete/rotation token: HMAC(tunnel_id) under a server-side secret,
        // given only to the creator. Required to delete a LIVE tunnel.
        const deleteToken = env.WORKER_SIGNING_KEY ? await hmacHex(env.WORKER_SIGNING_KEY, tunnel.id) : "";
        return json(201, { tunnel_id: tunnel.id, connector_token: connectorToken, hostname, delete_token: deleteToken });
      } catch (err) {
        return json(500, { error: "unexpected", detail: String(err) });
      }
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/tunnels/")) {
      const id = url.pathname.split("/")[3] ?? "";
      if (!/^[\w-]+$/.test(id)) return json(400, { error: "invalid tunnel id" });
      if (rateLimited(req, 20, 3600_000)) return json(429, { error: "rate limited" });
      const user = String(url.searchParams.get("user") ?? "").toLowerCase();
      const token = String(url.searchParams.get("token") ?? "");
      try {
        // Tunnel ids are publicly discoverable via the DNS CNAME: a delete of
        // a LIVE tunnel is only allowed with a valid delete token. Dead
        // tunnels remain freely cleanable (restart/re-share flow).
        const tokenOk = env.WORKER_SIGNING_KEY && token && fixedEqual(token, await hmacHex(env.WORKER_SIGNING_KEY, id));
        if (!tokenOk && (await tunnelLive(id, env))) {
          return json(403, { error: "tunnel is live: delete token required" });
        }
        const del = await cf(`/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${id}`, { method: "DELETE" }, env);
        if (USER_RE.test(user)) await deleteDns(env, user);
        return del.ok ? json(200, { ok: true }) : json(502, { error: "tunnel delete failed", detail: del.data });
      } catch (err) {
        return json(500, { error: "unexpected", detail: String(err) });
      }
    }

    return json(404, { error: "not found" });
  },
};
