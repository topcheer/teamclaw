# AGENTS.md

Guidance for coding agents working in this repository.

## Project Snapshot

- **What**: TeamClaw is an OpenClaw plugin (`@teamclaws/teamclaw`) that turns one or more OpenClaw instances into a coordinated virtual software team — a controller orchestrates role-based workers (pm, architect, developer, qa, infra-engineer, ...) through an execution-ready task flow with clarification blocking, Git-backed workspace collaboration, and on-demand worker provisioning (`process`, `docker`, `kubernetes`).
- **Repo**: `github.com/topcheer/teamclaw`. Plugin source lives in `src/`; `openclaw/` is the upstream OpenClaw **git submodule** (do not edit it as part of normal TeamClaw work).
- **Stack**: TypeScript, ESM (`"type": "module"`), Node >= 22 (CI uses 24.x). Runtime deps are minimal: `@sinclair/typebox`, `ws`, `bonjour-service`, `json5`. `openclaw` is a peer dependency (>= 2026.3.24).
- **Entry point**: `src/index.ts` — `definePluginEntry({ id: "teamclaw", ... })` registers controller or worker mode based on `config.mode`. Installer CLI: `src/cli.mjs` (exposed as `teamclaw` bin).
- **Docs**: `README.md` (repo overview), `INSTALL.md` (setup/packaging), `DESIGN.md` (architecture), `src/README.md` (package-facing).

## Validation

Fast regression anchors (run these first; they are plain Node scripts, no framework):

```bash
node tests/test-worker-contracts.mjs
node tests/test-controller-intake.mjs
```

Docker integration harness:

```bash
bash tests/run-tests.sh              # full run
bash tests/run-tests.sh --skip-build # reuse built artifacts
bash tests/run-tests.sh --keep       # keep containers for debugging
```

Build / package checks (from repo root, using the `src/` package):

```bash
npm --prefix src run build                 # tsc -p tsconfig.build.json + copy src/ui
npm --prefix src run manifest:sync         # regenerate openclaw.plugin.json
npm --prefix src run release:check         # package validation
npm --prefix src run release:clawhub:dry-run
```

Notes:
- Tests in `tests/*.mjs` are **source-level smoke tests**: they read `.ts` source files and `assert.match` against expected exports/behaviors. If you rename or restructure an exported prompt builder, injector, or tool factory, these tests are the contract — update both sides deliberately.
- CI (`.github/workflows/`) covers npm release publishing and the runtime image; there is no per-PR lint/test workflow, so run the smoke anchors locally before committing.
- `tests/test-api.sh` covers the clarification loop (`blocked -> answered -> resumed`) end-to-end.

## Architecture

```text
src/                  # npm package + OpenClaw plugin
  index.ts            # plugin entry; registers controller or worker mode
  cli.mjs             # guided installer (`npx @teamclaws/teamclaw install`)
  openclaw.plugin.json# generated plugin manifest (sync via manifest:sync)
  skills/             # bundled skills (SKILL.md frontmatter has its own version:)
  src/                # core source
    config.ts, types.ts       # plugin config schema + shared types (TypeBox)
    roles.ts                  # role registry (pm, architect, developer, qa, ...)
    state.ts                  # persisted team state
    prompt-policy.ts          # shared prompt/orchestration rules
    interaction-contracts.ts  # clarification contracts
    git-collaboration.ts      # Git workspace sync/publish (remote or bundle fallback)
    openclaw-workspace.ts     # OpenClaw workspace/project management
    task-executor.ts          # role task execution
    controller/               # controller mode: HTTP server, Web UI, WebSocket,
                              # task routing, intake prompts, worker provisioning,
                              # orchestration manifest, capacity
    worker/                   # worker mode: worker-service, tools, prompt injector,
                              # message queue, skill installer
    ui/                       # controller Web UI assets (copied to dist, not compiled)
desktop/              # desktop client (Electron-style wrapper for controller UI)
tests/                # integration + source-level smoke tests (plain node, no deps)
scripts/              # repo utilities (symlink-extension.sh, release helpers)
deploy/helm           # Helm charts
docs/                 # GitHub Pages site
.github/workflows/    # CI: npm release + runtime image publishing (see below)
skills/               # ClawHub-published setup skill (teamclaw-setup)
screenshots/          # real product screenshots used by docs
Dockerfile.teamclaw   # Dockerfile for the TeamClaw OpenClaw runtime image
openclaw/             # upstream submodule — read-only for TeamClaw work
```

Continuous delivery (`.github/workflows/`):
- `teamclaw-plugin-npm-release.yml` — publishes `@teamclaws/teamclaw` to npm via trusted publishing when a `v*` tag is pushed or `src/**` / release scripts change on `main`; also supports `workflow_dispatch` for a specific SHA on `main`. Runs on Node 24.x.
- `teamclaw-runtime-image.yml` — builds and pushes `ghcr.io/topcheer/teamclaw-openclaw` (linux/amd64 + linux/arm64) when `openclaw/**`, `src/**`, or `scripts/prepare-teamclaw-runtime-context.mjs` change on `main`. Image tags: the package version, `sha-<12>`, plus `latest` (or `beta` when the version contains `-beta.*`) only when building main HEAD; refs not on `main` are rejected.
- Both workflows use a `concurrency` group keyed by ref with `cancel-in-progress: false` and validate the ref is on `main` before publishing — never expect a release to run from a feature branch.

Key behavioral contract: the controller creates **only execution-ready work** (no speculative backlogs). When a role cannot safely continue (missing decision, credential, or infra), it raises a **clarification**, the task becomes `blocked`, and it resumes after a human answer. Never "guess" missing infrastructure in code or prompts — this rule is asserted in tests.

Local dev setup: `git submodule update --init --recursive`, then `bash scripts/symlink-extension.sh` (creates `openclaw/extensions/teamclaw -> ../../src`), then `pnpm install` and `pnpm openclaw gateway run` from `openclaw/`.

## Coding Conventions

- **ESM + `.js` import specifiers**: all internal imports use `./foo.js` paths even in `.ts` files (Node ESM resolution). Keep this style.
- **Factory functions over classes**: services are created via `createXxx({...deps})` factories (`createControllerService`, `createWorkerTools`, `createRoleTaskExecutor`). Dependency objects are passed explicitly, including a `logger` from the plugin API — use it rather than `console.*`.
- **TypeBox for schemas**: config and interaction contracts use `@sinclair/typebox`; shared types live in `src/src/types.ts`. Parse untrusted config via `parsePluginConfig`.
- **Prompts as composable parts**: system prompts are built from named exported functions (`buildControllerIntakeSystemPrompt`, `parts.push(...buildControllerWorkflowRules())`). Keep prompt builders exported and testable — smoke tests match on their names.
- **Promises/async throughout**: use `node:fs/promises`, `node:path`; no sync FS in service paths.
- **Indentation 2 spaces; double-quoted strings** (match existing files).
- **Commit style**: Conventional Commits prefixes (`feat:`, `fix(desktop):`, `fix(ui):`, ...) with scope when applicable; English commit messages; append `Co-Authored-By` trailer per repo tooling.
- **Submodule discipline**: never commit changes inside `openclaw/`; if an upstream change is needed, surface it to the user instead.
- **Node version nuance**: `engines` allows Node >= 22, but release CI runs Node 24.x — avoid stdlib/APIs newer than Node 22 so both hold.
- **Versioning (CalVer-style)**: `src/package.json` uses a `YYYY.M.N` scheme. The runtime-image workflow reads this version for image tags and routes `-beta.*` suffixes to the `beta` channel, so bump it deliberately; never hand-tag images. Bundled skills carry independent `version:` frontmatter in `src/skills/*/SKILL.md`.
- **Generated files**: `src/openclaw.plugin.json` is generated — run `npm --prefix src run manifest:sync` after changing plugin metadata rather than hand-editing. Bump `version:` in `src/skills/*/SKILL.md` when a bundled skill changes.
