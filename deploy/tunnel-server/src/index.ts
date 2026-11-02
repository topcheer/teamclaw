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
const DOMAIN = "apps.teamclaw.dev";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface Env {
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
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

function tunnelName(user: string): string {
  return `${TUNNEL_PREFIX}${user}`;
}

function hostnameFor(user: string): string {
  return `${user}.${DOMAIN}`;
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
      const body = (await req.json().catch(() => ({}))) as { github_user?: string; local_port?: number };
      const user = String(body.github_user ?? "").trim().toLowerCase();
      if (!USER_RE.test(user)) return json(400, { error: "invalid github_user" });
      const port = Number(body.local_port) > 0 ? Math.floor(Number(body.local_port)) : 9527;

      try {
        // Replace semantics: at most MAX_TUNNELS_PER_USER live tunnel per user.
        const all = await listActiveTunnels(env);
        const mine = all.filter((t) => t.name === tunnelName(user));
        if (mine.length + 1 > MAX_TUNNELS_PER_USER) {
          await teardownUserTunnels(env, user);
        } else if (all.length >= GLOBAL_WATERMARK) {
          return json(429, { error: "tunnel watermark reached, try again later" });
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

        return json(201, { tunnel_id: tunnel.id, connector_token: connectorToken, hostname });
      } catch (err) {
        return json(500, { error: "unexpected", detail: String(err) });
      }
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/tunnels/")) {
      const id = url.pathname.split("/")[3] ?? "";
      if (!/^[\w-]+$/.test(id)) return json(400, { error: "invalid tunnel id" });
      const user = String(url.searchParams.get("user") ?? "").toLowerCase();
      try {
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
