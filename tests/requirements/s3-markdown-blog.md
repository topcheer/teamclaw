# Requirement: Team marketing blog on S3-backed static hosting

## User story

As the TeamClaw demo product owner, I want a small static marketing blog
published to S3-backed static hosting, so that prospective users can read
about the team's capabilities.

## Scope

- A single-page static site with three sections: landing headline, feature
  list, and a demo walkthrough.
- Plain HTML + CSS, no JavaScript build step.
- Content is committed to the repository under `site/`.

## Acceptance criteria

1. `site/index.html` exists and references `site/style.css`.
2. The page contains the three required sections with non-empty content.
3. No absolute filesystem paths or secrets appear in the rendered HTML.
4. The site is static: opening `site/index.html` from the filesystem renders
   correctly without a server.

> Fixture requirement for the docker e2e harness default
> (tests/run-tests.sh). Override with TEAMCLAW_E2E_REQUIREMENT_FILE.
