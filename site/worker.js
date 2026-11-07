import site from "./index.html";
import privacy from "./privacy.html";

const HEADERS = {
  "content-type": "text/html;charset=utf-8",
  "cache-control": "public, max-age=300",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          headers: { "content-type": "text/plain;charset=utf-8" },
        });
      }
      // Single-page marketing site: serve the page for any path.
      if (url.pathname === "/privacy") {
        return new Response(request.method === "HEAD" ? null : privacy, {
          status: 200,
          headers: HEADERS,
        });
      }
      return new Response(request.method === "HEAD" ? null : site, {
        status: 200,
        headers: HEADERS,
      });
    }

    return new Response("Method not allowed\n", {
      status: 405,
      headers: { "content-type": "text/plain;charset=utf-8" },
    });
  },
};
