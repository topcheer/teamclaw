import site from "./index.html";
import privacy from "./privacy.html";
import robots from "./robots.txt";
import sitemap from "./sitemap.xml";
import llms from "./llms.txt";
import ogImage from "./og-image.png";

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

const HTML_HEADERS = {
  ...BASE_HEADERS,
  "content-type": "text/html;charset=utf-8",
  "cache-control": "public, max-age=300",
};

const TEXT_HEADERS = (type) => ({
  ...BASE_HEADERS,
  "content-type": type,
  "cache-control": "public, max-age=300",
});

const NOT_FOUND = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found — TeamClaw</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="https://teamclaw.dev/">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f1e6;color:#14110f;font:18px/1.6 -apple-system,"Segoe UI",sans-serif}
main{max-width:520px;padding:48px 24px;text-align:center}
h1{font-size:56px;margin:0 0 8px;letter-spacing:-.02em}
p{color:#2a2521;margin:0 0 24px}
a{display:inline-block;padding:10px 20px;border:2px solid #14110f;border-radius:999px;background:#ff4a1c;color:#fff;text-decoration:none;font-weight:700;box-shadow:4px 4px 0 #14110f}
</style>
</head>
<body>
<main>
<h1>404</h1>
<p>That page does not exist. The team is still shipping at teamclaw.dev.</p>
<a href="/">Back to TeamClaw</a>
</main>
</body>
</html>
`;

// Explicit route table: anything not listed is a real 404 so search and AI
// crawlers never receive the homepage for sitemap.xml / llms.txt / unknown paths.
const ROUTES = {
  "/": { body: site, headers: HTML_HEADERS },
  "/privacy": { body: privacy, headers: HTML_HEADERS },
  "/robots.txt": { body: robots, headers: TEXT_HEADERS("text/plain;charset=utf-8") },
  "/sitemap.xml": { body: sitemap, headers: TEXT_HEADERS("application/xml; charset=utf-8") },
  "/llms.txt": { body: llms, headers: TEXT_HEADERS("text/plain;charset=utf-8") },
  "/og-image.png": {
    body: ogImage,
    headers: { ...BASE_HEADERS, "content-type": "image/png", "cache-control": "public, max-age=86400" },
  },
};

const REDIRECTS = {
  "/index.html": "/",
  "/privacy.html": "/privacy",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: TEXT_HEADERS("text/plain;charset=utf-8"),
      });
    }

    const redirect = REDIRECTS[url.pathname];
    if (redirect) {
      return new Response(null, {
        status: 301,
        headers: { ...BASE_HEADERS, location: `${url.origin}${redirect}` },
      });
    }

    const route = ROUTES[url.pathname];
    if (route) {
      return new Response(request.method === "HEAD" ? null : route.body, {
        status: 200,
        headers: route.headers,
      });
    }

    return new Response(request.method === "HEAD" ? null : NOT_FOUND, {
      status: 404,
      headers: { ...HTML_HEADERS, "x-robots-tag": "noindex" },
    });
  },
};
