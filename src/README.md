# @teamclaws/teamclaw

TeamClaw is an **OpenClaw plugin** that turns multiple roles into a collaborative virtual software team.

It supports:

- `controller` / `worker` modes
- externally registered workers
- clarifications, workspace browsing, and Web UI
- Git-based collaboration
- on-demand worker provisioning with `process`, `docker`, and `kubernetes`

## Install

For the easiest guided setup, run:

```bash
npx -y @teamclaws/teamclaw install
```

The guided installer automatically uses OpenClaw's break-glass install flag for TeamClaw, because TeamClaw legitimately needs host orchestration capabilities that the built-in scanner marks as critical.

This installer can:

- install/update the TeamClaw plugin in OpenClaw
- detect your local `openclaw.json`
- let you choose the installation mode
- let you choose a model from the models already defined in OpenClaw
- let you choose the OpenClaw workspace directory
- default TeamClaw to a dedicated `teamclaw` agent/workspace instead of reusing `main`
- prefill Docker/Kubernetes provisioning with the published TeamClaw runtime image
- prefill Docker workspace persistence with a named volume and Kubernetes persistence with a PVC name

By default, guided install now uses an independent TeamClaw agent/workspace layout:

- `agent:teamclaw:*` sessions
- sibling workspace such as `~/.openclaw/workspace-teamclaw`

For advanced compatibility only, you can force the legacy shared-`main` layout:

```bash
npx -y @teamclaws/teamclaw install --agent-mode main
```

If you only want to install the plugin manually, use:

```bash
openclaw plugins install --dangerously-force-unsafe-install @teamclaws/teamclaw
```

If you want to force the ClawHub package path, use:

```bash
openclaw plugins install --dangerously-force-unsafe-install clawhub:@teamclaws/teamclaw
```

Then enable and configure TeamClaw in your `openclaw.json`.

The published TeamClaw runtime image also preinstalls the `clawhub` CLI, so containerized workers can discover and install skills from ClawHub without an extra bootstrap step.

## Maintainer release flow

For maintainers, TeamClaw now uses two release paths:

1. **npm package** — published by GitHub Actions via `.github/workflows/teamclaw-plugin-npm-release.yml`
2. **ClawHub code plugin + bundled skills** — published manually from the CLI

Before either release path, sync and validate the generated plugin manifest:

```bash
npm --prefix src run manifest:sync
npm --prefix src run release:check
```

Preview the ClawHub release commands without publishing:

```bash
npm --prefix src run release:clawhub:dry-run
```

When ready to publish to ClawHub, log in first and then run:

```bash
clawhub login
bash scripts/teamclaw-clawhub-release.sh --publish
```

The ClawHub release helper publishes the `@teamclaws/teamclaw` code plugin from `src/` and then publishes only the bundled skills under `src/skills/`. Update each skill's frontmatter `version:` in `src/skills/*/SKILL.md` before a real publish if that skill changed.

## Recommended first setup

For a first-time setup, the safest path is:

1. Start with single-host `process` provisioning
2. Validate the workflow with a small smoke-test task
3. Expand to external workers, Docker, or Kubernetes after the basics are working

When on-demand provisioning is enabled, TeamClaw now treats controller startup as a readiness phase, not just a process-up check. During that warm-up, `/api/v1/health` returns a non-OK status until the controller has verified writable runtime paths and successfully brought the configured startup worker roles online.

## Documentation

- Website: <https://topcheer.github.io/teamclaw/>
- Installation guide: <https://github.com/topcheer/teamclaw/blob/main/INSTALL.md>
- Repository overview: <https://github.com/topcheer/teamclaw/blob/main/README.md>
- Design notes: <https://github.com/topcheer/teamclaw/blob/main/DESIGN.md>
