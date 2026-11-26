#!/usr/bin/env node
// Source-level smoke test for the marketing site's SEO/GEO surface.
// Mirrors the route contract in site/worker.js and the structured data in
// site/index.html. Plain Node, no framework (see AGENTS.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const read = (name) => fs.readFileSync(path.join(siteDir, name), "utf8");

const html = read("index.html");
const worker = read("worker.js");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");
const llms = read("llms.txt");
const privacy = read("privacy.html");

// --- social + canonical ---
assert.match(html, /<html lang="en">/, "index.html declares its language");
assert.match(html, /rel="canonical" href="https:\/\/teamclaw\.dev\/"/, "canonical URL");
assert.match(html, /property="og:image" content="https:\/\/teamclaw\.dev\/og-image\.png"/, "og:image absolute URL");
assert.match(html, /property="og:image:width" content="1200"/, "og:image width");
assert.match(html, /property="og:image:height" content="630"/, "og:image height");
assert.match(html, /name="twitter:card" content="summary_large_image"/, "twitter card");
assert.match(privacy, /rel="canonical" href="https:\/\/teamclaw\.dev\/privacy"/, "privacy canonical");

// --- JSON-LD parses and the FAQ matches the visible FAQ verbatim ---
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
// One block may hold an array of entities (or an object with @graph).
const entities = blocks.flatMap((block) => (Array.isArray(block) ? block : block["@graph"] ? block["@graph"] : [block]));
assert.deepEqual(entities.map((o) => o["@type"]), ["SoftwareApplication", "Organization", "FAQPage"], "JSON-LD types");
assert.equal(entities.find((o) => o["@type"] === "SoftwareApplication").license, "https://www.gnu.org/licenses/agpl-3.0.html", "SoftwareApplication license URL");
const faq = entities.find((o) => o["@type"] === "FAQPage").mainEntity;
const visible = [...html.matchAll(/<summary>([^<]+)<\/summary>\s*<p>([^<]+)<\/p>/g)].map((m) => ({ q: m[1], a: m[2] }));
assert.equal(faq.length, 6, "six FAQ entries");
assert.deepEqual(
  faq.map((f) => ({ q: f.name, a: f.acceptedAnswer.text })),
  visible,
  "FAQPage JSON-LD is verbatim identical to the visible FAQ",
);
assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, "exactly one h1");

// --- robots / sitemap / llms ---
assert.match(robots, /^User-agent: \*\nAllow: \/$/m, "robots allows all");
assert.match(robots, /Sitemap: https:\/\/teamclaw\.dev\/sitemap\.xml/, "robots references the sitemap");
// Cloudflare owns the generative-engine crawler policy for this zone (managed
// robots.txt + edge enforcement); per-bot rules here would contradict it.
const uaLines = [...robots.matchAll(/^User-agent: (.+)$/gm)].map((m) => m[1]);
assert.deepEqual(uaLines, ["*"], "robots.txt only carries the wildcard rule");
assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/, "sitemap urlset");
assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ["https://teamclaw.dev/", "https://teamclaw.dev/privacy"], "sitemap URLs");
assert.ok(llms.startsWith("# TeamClaw\n"), "llms.txt H1");
assert.ok(llms.includes("npx -y @teamclaws/teamclaw install"), "llms.txt install command");
assert.match(llms, /License: GNU Affero General Public License v3\.0 only \(AGPL-3\.0-only\)/, "llms.txt states the license");
assert.equal(JSON.parse(read("../src/package.json")).license, "AGPL-3.0-only", "package.json license matches the site claim");

// --- worker route contract: explicit routes, real 404, redirects ---
for (const route of ['"/":', '"/privacy":', '"/robots.txt":', '"/sitemap.xml":', '"/llms.txt":', '"/og-image.png":']) {
  assert.ok(worker.includes(`${route} {`), `worker routes ${route}`);
}
assert.match(worker, /text\/plain;charset=utf-8/, "robots/llms are text/plain");
assert.match(worker, /application\/xml; charset=utf-8/, "sitemap is application/xml");
assert.match(worker, /"x-robots-tag": "noindex"/, "unknown paths are noindex");
assert.match(worker, /status: 404/, "unknown paths return 404");
assert.deepEqual(
  [...worker.matchAll(/"(\/[a-z./-]+)": "(\/[a-z./-]*)",?\n/g)].map((m) => [m[1], m[2]]).slice(0, 2),
  [["/index.html", "/"], ["/privacy.html", "/privacy"]],
  "legacy file paths redirect",
);
// No route may fall back to the homepage any more.
assert.doesNotMatch(worker, /serve the page for any path/, "catch-all homepage fallback removed");

console.log("Site SEO/GEO smoke passed.");
