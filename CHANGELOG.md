# Changelog

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
