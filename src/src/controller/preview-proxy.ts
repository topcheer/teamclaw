// PR-B of issue #204 (http-server monolith split): the preview subprocess
// proxy for /api/v1/previews/:id/* extracted verbatim from
// controller/http-server.ts. Zero behavior change - the route shell in
// http-server keeps the method whitelist + prefix match and calls this
// handler with the same request/response objects as before. This module must
// NEVER import http-server (the reverse edge exists:
// http-server -> preview-proxy); preview state arrives through the deps
// slice below.
import http from "node:http";
import zlib from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PluginLogger } from "../../api.js";
import type { TeamState } from "../types.js";
import { sendJson } from "../protocol.js";

/**
 * Structural slice of ControllerHttpDeps (http-server.ts) covering exactly
 * the fields the preview proxy reads. http-server keeps passing its full
 * ControllerHttpDeps object; TypeScript structural typing accepts it, so no
 * call site changes beyond the import path.
 */
export type PreviewProxyDeps = {
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
};

/**
 * /api/v1/previews/:id/* - proxy to the preview subprocess. `pathname` starts
 * with "/api/v1/previews/"; `requestUrl` is the parsed request URL (query
 * string is forwarded to the subprocess).
 */
export function handlePreviewProxyRequest(
  deps: PreviewProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  requestUrl: URL,
  pathname: string,
): void {
  const previewPrefix = "/api/v1/previews/";
  const remaining = pathname.slice(previewPrefix.length);
  const slashIdx = remaining.indexOf("/");
  const previewId = slashIdx >= 0 ? remaining.slice(0, slashIdx) : remaining;
  const subPath = slashIdx >= 0 ? remaining.slice(slashIdx) : "/";

  const state = deps.getTeamState();
  const preview = state?.previews?.[previewId];
  if (!preview || preview.status !== "healthy") {
    const status = preview?.status ?? "unknown";
    const errMsg = preview?.lastError;
    sendJson(res, 503, { error: "Preview not available", previewId, status, lastError: errMsg ?? undefined });
    return;
  }

  const proxyPathPrefix = `/api/v1/previews/${encodeURIComponent(previewId)}`;
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: preview.targetPort,
      path: subPath + (requestUrl.search || ""),
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${preview.targetPort}`,
        "accept-encoding": "identity",
        "x-forwarded-for": req.socket.remoteAddress ?? "",
        "x-forwarded-host": req.headers.host ?? "",
        "x-forwarded-proto": "http",
      },
    },
    (proxyRes: http.IncomingMessage) => {
      const contentType = (proxyRes.headers["content-type"] ?? "").toLowerCase();
      if (proxyRes.statusCode !== 200 && proxyRes.statusCode !== 201 && proxyRes.statusCode !== 301 && proxyRes.statusCode !== 302 && proxyRes.statusCode !== 304) {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        return;
      }

      if (contentType.includes("text/html")) {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          let raw = Buffer.concat(chunks);
          // Decompress if the upstream response is compressed (brotli/gzip/deflate).
          const encoding = (proxyRes.headers["content-encoding"] ?? "").toLowerCase();
          try {
            if (encoding === "br") {
              raw = zlib.brotliDecompressSync(raw);
            } else if (encoding === "gzip") {
              raw = zlib.gunzipSync(raw);
            } else if (encoding === "deflate") {
              raw = zlib.inflateSync(raw);
            }
          } catch {
            // If decompression fails, use raw bytes as-is.
          }
          const body = raw.toString("utf-8");
          // Rewrite absolute-path references (href="/...", src="/...", action="/...")
          // to include the proxy prefix so all navigation stays within the proxy.
          const rewritten = body.replace(
            /\b(href|src|action)\s*=\s*"\/([^"]*)"/g,
            `$1="${proxyPathPrefix}/$2"`,
          ).replace(
            /\b(href|src|action)\s*=\s*'\/([^']*)'/g,
            `$1='${proxyPathPrefix}/$2'`,
          );
          const resHeaders = { ...proxyRes.headers };
          // We've decoded and rewritten the body — remove upstream encoding headers.
          delete resHeaders["content-encoding"];
          delete resHeaders["transfer-encoding"];
          resHeaders["content-length"] = String(Buffer.byteLength(rewritten, "utf-8"));
          res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
          res.end(rewritten);
        });
      } else {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    },
  );
  proxyReq.on("error", (err: Error) => {
    deps.logger.warn(`Controller: preview proxy error for ${previewId}: ${String(err)}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Preview proxy error", previewId, message: String(err) });
    }
  });
  req.pipe(proxyReq);
}
