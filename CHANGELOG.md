# Changelog

## 2026.11.0

Released 2026-11-04. This cycle spans PRs #85-#108 (all merged to main).

### Kubernetes operator (GA path)

- Full operator with embedded management UI: token login, team dashboard
  (Ready/ConfigReady/worker pills), create/edit/delete forms with inline
  `openclaw.json` (auto-creates the backing Secret) (#68, #75, #80)
- Helm charts published to GHCR as OCI artifacts
  (`oci://ghcr.io/topcheer/charts/teamclaw{,-operator}`); chart changes
  auto-publish via CI (#105, #107, #108)
- Operator hardening: PVC reconcile idempotency (bound claims expand-only),
  roles/rolebindings watch verbs, controller `imagePullPolicy: Always` for
  `:latest`, plugin symlink baked into the controller bootstrap (#104, #80, #106)

### Runtime image rebuilt on the official base

- `Dockerfile.teamclaw` layers the plugin onto `ghcr.io/openclaw/openclaw`
  (upstream 2026.10.10) - minutes per build instead of a 40-60min full
  source build; bootstrap uses the official `openclaw.mjs` entrypoint (#98, #103)
- openclaw submodule now tracks upstream `openclaw/openclaw` main directly
  (fork retired); fork main was synced 84,260 commits forward before the
  switch (#87, #88)

### Worker provisioning fixes

- Baked-in plugin root resolution for process workers (image-layout probing
  via `process.argv[1]`) (#86)
- Per-backend `agents.entries` handling: process workers keep the teamclaw
  entry (same-runtime requirement), container backends fold to legacy
  defaults (#66, #82)
- TeamAuto wall-clock aligned schedules with strict cron parsing (#77, #82)

### Site & docs

- teamclaw.dev updated with the Kubernetes deployment story; README/INSTALL
  gained the helm/operator quick-start paths

## 2026.7.0

Released 2026-11-03. This cycle spans PRs #77–#84 (all merged to main).

### Features

- **Desktop experience overhaul**: titleless window with an in-page drag
  titlebar (#78); unified day/night theming with a full color system
  overhaul (#79); internet tunnel card in the Controller view (#81).

### Fixes

- **Process-worker crash-loop (exit 78)**: `agents.entries` is no longer
  unconditionally deleted from provisioned worker configs. Process workers
  (sharing the controller's runtime) keep only their `teamclaw` entry — the
  runtime requires at least one configured agent — while container workers
  keep the legacy `defaults`-only schema that older openclaw runtimes
  accept; dangling `agentId` references are remapped to the surviving entry
  (#82). Behavior is now locked in by per-backend unit tests (#84).
- **Operator stale-image deploys on k3s**: controller Deployments use
  `imagePullPolicy: Always` for `:latest` images (#80).
- **TeamAuto sweep drift**: wall-clock aligned sweep scheduling with strict
  cron parsing — invalid expressions fail loudly instead of silently
  degrading to a one-minute cadence (#77).
- **Desktop**: balanced 2×2 controller grid in the Controller view (#83).
- **Tests**: realigned the `test-openclaw-workspace` smoke contract with the
  tokenized color system from #79 (disabled-button contrast now pinned via
  `var(--info-bg)`/`var(--neutral-text)` instead of the removed hex values).

## 2026.6.0

Released 2026-11-03. This cycle spans PRs #59–#74 (all merged to main).

### Features

- **Internet tunnel sharing**: one-click share of the local dashboard at
  `team-<github_user>.teamclaw.dev` — a Cloudflare Worker provisions
  remotely-managed tunnels, the local controller runs `cloudflared`, and
  visitors must enter the gate token shown in the local UI. Includes
  cloudflared install status + one-click install (macOS/Linux/Windows) with
  async progress for install and share, connector log pipeline, and a
  visitor-degraded panel when the dashboard itself is opened through the
  tunnel domain.
- **Tunnel resilience & security**: DoH-pinned control-plane egress;
  kill -9-safe boot recovery (share state persisted to disk, pid-reuse-safe
  orphan reaping, reconnect of the same tunnel so gate tokens and visitor
  cookies survive gateway restarts); per-IP rate limits, a live-share guard,
  and HMAC delete tokens on the provisioning API.
- **Web UI toasts**: task / clarification / TeamAuto activity notifications
  with per-kind toggles; TeamAuto activity streamed live over WebSocket.
- **Kubernetes operator (P0)**: TeamClaw CRD + reconciler + install
  manifests, complete RBAC, operator image published to ghcr, and an
  operator UI (SPA) with a CR management API.

### Fixes

- Tunnel/CDN edge-cache freezes: `index.html` is served with
  content-versioned asset URLs (`?v=<hash>`) so UI deploys always reach
  browsers behind the Cloudflare edge (previously up to 4h stale).
- Provisioned worker configs: `agents.entries` folded into legacy defaults.
- TeamAuto activity: provision-failure entries recorded with a bounded
  dedupe map.

### CI / Infrastructure

- Operator image publish workflow (ghcr), upstream openclaw Dockerfile
  drift watch, controller-gen pinned as a go tool dependency.

## 2026.5.0

Released 2026-11-02. This cycle spans PRs #30–#57 (all merged to main).

### Features

- **GitHub OAuth device-flow login** with PKCE and refresh-token persistence
  (`GITHUB_AUTH.md`); no clean secrets required for setup.
- **TeamAuto autonomous loop**: async repo binding with phased coverage
  overlays, joint three-role full reviews (umbrella issues), persisted
  activity stream that survives restarts, and dedupe/dead-letter fixes.
- **Read/write collaboration contract**: writeMode classification,
  serialized writes per repository, and worktree + PR delivery for write
  tasks.
- **Task checkpoint resume**: heartbeat checkpoints with session reuse and
  a three-resume cap (`CHECKPOINT_RESUME.md`).
- **Web UI workbench visual system** (warm charcoal + amber gold) with the
  arc claw-scratch logo unified across web, desktop, and site.
- **Web UI**: deep-linkable tabs (hash routing), task sorting / paging /
  keyword filtering, bind coverage overlay, slim scrollbars, and a
  consistent whitespace system.
- **Per-role model selection** with a live model catalog (web UI and
  desktop settings views; role overrides > team default) and workspace
  relocation from the UI.
- **data-engineer role** (11 role types total) and `maxConcurrentTasks`
  config.

### Fixes

- openclaw 2026.10 compatibility: activation.onStartup + contracts.tools
  registration gates, keyed `agents.entries` schema, mode-only exec,
  capability-consent install retry, compiled-dist packaging.
- Runtime image CI: upstream Dockerfile prune rename, unused-patch
  tolerance, matrix addon gate downgraded to warning.
- `AgentToolResult.details` on all controller/worker tool returns.
- Stale provisioned-worker cleanup and toast notifications in the web UI.

### Dependencies

- openclaw pinned to 2026.10.9 as a direct dependency (aligned with the
  validated host).

## 2026.4.4

Released 2026-11-01. openclaw 2026.10.9 alignment: install capability
consent, activation/contracts registration gates, keyed agents.entries,
mode-only exec, per-role model overrides, workspace relocation, stale
worker cleanup, toasts.

## 2026.4.3

Released earlier in the 2026.10 compatibility cycle; see git history for
details (PRs #30–#56).
