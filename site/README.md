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
