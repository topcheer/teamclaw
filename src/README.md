# @teamclaws/teamclaw

TeamClaw is an **OpenClaw plugin** that turns multiple roles into a collaborative virtual software team.

It supports:

- `controller` / `worker` modes
- single-instance `localRoles`
- clarifications, workspace browsing, and Web UI
- Git-based collaboration
- on-demand worker provisioning with `process`, `docker`, and `kubernetes`

## Install

For the easiest guided setup, run:

```bash
npx -y @teamclaws/teamclaw install
```

This installer can:

- install/update the TeamClaw plugin in OpenClaw
- detect your local `openclaw.json`
- let you choose the installation mode
- let you choose a model from the models already defined in OpenClaw
- let you choose the OpenClaw workspace directory
- prefill Docker/Kubernetes provisioning with the published TeamClaw runtime image
- prefill Docker workspace persistence with a named volume and Kubernetes persistence with a PVC name

If you only want to install the plugin manually, use:

```bash
openclaw plugins install @teamclaws/teamclaw
```

If you want to force the ClawHub package path once the plugin is published there, use:

```bash
openclaw plugins install clawhub:@teamclaws/teamclaw
```

Then enable and configure TeamClaw in your `openclaw.json`.

The published TeamClaw runtime image also preinstalls the `clawhub` CLI, so containerized workers can discover and install skills from ClawHub without an extra bootstrap step.

## Recommended first setup

For a first-time setup, the safest path is:

1. Start with a single machine and `controller + localRoles`
2. Validate the workflow with a small smoke-test task
3. Expand to distributed or on-demand workers after the basics are working

## Documentation

For complete setup and architecture details, see:

- Installation guide: <https://github.com/topcheer/teamclaw/blob/main/INSTALL.md>
- Repository overview: <https://github.com/topcheer/teamclaw/blob/main/README.md>
- Design notes: <https://github.com/topcheer/teamclaw/blob/main/DESIGN.md>
