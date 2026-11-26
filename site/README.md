# teamclaw.dev — marketing site

Single-page marketing site for TeamClaw, served by a Cloudflare Worker on the
custom domain **teamclaw.dev** (zone already active in Cloudflare).

## Files

- `index.html` — the whole site (inline CSS + JS, no build step)
- `worker.js` — Worker entry; imports `index.html` as a Text module and serves it

## Deployed as

- Worker name: `teamclaw-site`
- Custom domain: `teamclaw.dev` (attached via Workers Custom Domains)
- workers.dev route: `teamclaw-site.<account-subdomain>.workers.dev`

## Redeploy

Option A — wrangler (from this directory):

```bash
npx wrangler deploy worker.js --name teamclaw-site \
  --compatibility-date 2025-09-01 \
  --rule type=Text,globs=**/*.html
```

Option B — API (multipart module upload):

```
PUT /accounts/{account_id}/workers/scripts/teamclaw-site
  metadata: {"main_module":"worker.js","compatibility_date":"2025-09-01",
             "rules":[{"type":"Text","globs":["**/*.html"],"fallthrough":true}]}
  parts: worker.js (application/javascript+module), index.html (text/plain)
```

After `index.html` changes, bump `max-age` or purge cache if needed.

## Making changes

All copy is grounded in the actual product (README.md / DESIGN.md facts:
11 roles, 4 topologies, clarification-first flow, git collaboration, real
config snippets, real install command). Keep it that way when editing.

## Desktop links

The `#desktop` section links to the rolling `desktop-latest` GitHub pre-release
(https://github.com/topcheer/teamclaw/releases/tag/desktop-latest), which carries
the macOS `.dmg`, Windows `Setup.exe` and Linux `AppImage`/`.deb` builds from
`desktop-release.yml`. Do not use `/releases/latest` - it resolves to the newest
npm version tag, which has no desktop assets. Mac App Store and Microsoft Store
listings are still in submission (`desktop/msstore/README.md`); switch the
buttons to the store pages once they are live.

## Routes and crawler files

`worker.js` serves an explicit route table; anything else is a real 404 with
`X-Robots-Tag: noindex` (no catch-all homepage fallback):

- `/` (`index.html`), `/privacy` (`privacy.html`); `/index.html` and `/privacy.html` 301 to them
- `/robots.txt` - allows all crawlers, lists the common generative-engine bots and points at the sitemap
- `/sitemap.xml` - `/` and `/privacy`
- `/llms.txt` - short factual summary for LLM crawlers (what it is, install, key links)
- `/og-image.png` - 1200x630 social preview card

Structured data lives in `index.html` as JSON-LD (`SoftwareApplication`,
`Organization`, `FAQPage`). The FAQ answers must stay verbatim identical to the
visible FAQ; `tests/test-site-seo.mjs` asserts that, so edit both together.
No file mentions a license until one is decided.
