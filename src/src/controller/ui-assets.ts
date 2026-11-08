// PR-A of issue #204 (http-server monolith split): static web UI asset
// serving extracted verbatim from controller/http-server.ts. Zero behavior
// change - the route shells in http-server call these functions unchanged.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { sendError } from "../protocol.js";

// Tunnel/CDN caches rewrite the origin's Cache-Control: no-cache into a long
// browser freeze for cacheable extensions like .js (observed: Cloudflare
// Browser Cache TTL max-age=14400 on tunneled UI assets). A UI update then
// never reaches visitors through the tunnel. Serving content-versioned URLs
// (?v=<hash>) makes every UI deploy a URL no browser or edge has ever seen,
// so stale-cache behavior cannot recur.
const uiAssetVersionCache = new Map<string, { mtimeMs: number; version: string }>();

function uiAssetVersion(uiPath: string, file: string): string {
  const full = path.join(uiPath, file);
  try {
    const mtimeMs = fs.statSync(full).mtimeMs;
    const cached = uiAssetVersionCache.get(full);
    if (cached && cached.mtimeMs === mtimeMs) return cached.version;
    const version = createHash("sha1").update(fs.readFileSync(full)).digest("hex").slice(0, 10);
    uiAssetVersionCache.set(full, { mtimeMs, version });
    return version;
  } catch {
    return String(Date.now()); // unreadable asset: bust for this request
  }
}

const UI_HTML_ASSET_REFS = [
  "/ui/style.css",
  "/ui/app.js",
  "/ui/assets/teamclaw-app-icon.png",
];

export function serveVersionedHtml(res: ServerResponse, htmlPath: string): void {
  try {
    const uiPath = path.dirname(htmlPath);
    let html = fs.readFileSync(htmlPath, "utf8");
    for (const ref of UI_HTML_ASSET_REFS) {
      html = html.split(`"${ref}"`).join(`"${ref}?v=${uiAssetVersion(uiPath, ref.slice("/ui/".length))}"`);
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(html);
  } catch {
    sendError(res, 404, "File not found");
  }
}

export function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      // UI assets change with every plugin deploy on a localhost controller;
      // always revalidate so browsers never stick to a stale app.js.
      "Cache-Control": "no-cache",
    });
    res.end(content);
  } catch {
    sendError(res, 404, "File not found");
  }
}
