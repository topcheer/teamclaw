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
 */

const USER_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const MAX_TUNNELS_PER_USER = 1;
const GLOBAL_WATERMARK = 800; // refuse new tunnels past this to protect the account limit (1000)
const TUNNEL_PREFIX = "teamclaw-tunnel-";
const DOMAIN = "teamclaw.dev";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  WORKER_SIGNING_KEY?: string; // HMAC secret: per-tunnel delete tokens
}

interface CfTunnel {
  id: string;
  name: string;
  status?: string;
  deleted_at?: string | null;
  token?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
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
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

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
