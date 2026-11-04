# TeamClaw Tunnel Deployment Guide (Internet Share)

How `share-with-tunnel` works in production, including containers (Docker / Kubernetes), plus the cloudflared install contract that the controller relies on.

For plugin architecture see [`DESIGN.md`](./DESIGN.md); for first-time setup see [`INSTALL.md`](./INSTALL.md).

## How the tunnel works

1. The controller asks the Cloudflare Worker (`deploy/tunnel-server`) to create a **remotely-managed tunnel** and returns a connector token.
2. The controller runs a local `cloudflared` connector with that token (`tunnel --no-autoupdate --protocol http2 run --token ...`).
3. Visitors hit `https://team-<github-user>.teamclaw.dev` and must enter the **gate token** shown in the local web-ui (Workspace tab → Tunnel panel).

No local ports are opened to the internet; the connector makes outbound-only connections.

## cloudflared install contract

The web-ui Tunnel panel shows install status and offers a **one-click install**. Platform matrix:

| Platform | Mechanism | Install target |
|---|---|---|
| macOS | `brew install cloudflared`, tarball fallback (`cloudflared-darwin-<arch>.tgz`) | Homebrew prefix / `$HOME/.local/bin` |
| Linux | **raw binary** `cloudflared-linux-<arch>` (⚠ no `.tgz` asset exists for Linux) | `$HOME/.local/bin/cloudflared` |
| Windows | `winget install Cloudflare.cloudflared` | winget-managed PATH |

Key implementation facts (audited 2026-11-04 against `ghcr.io/openclaw/openclaw:2026.10.10`):

- **Detection** (`findCloudflared()`) checks, in order: the install target `$HOME/.local/bin/cloudflared`, well-known absolute paths, then every `PATH` entry. A bare `fs.existsSync("cloudflared")` is a *CWD* check, not a PATH lookup — do not reintroduce it.
- **Linux download** fetches the raw binary asset directly (official releases ship `.tgz` only for darwin; the linux `.tgz` URL 404s).
- **curl-less fallback**: if `curl` is absent or fails (distroless images), a native `https` downloader with redirect following is used.
- **Static binary**: the linux cloudflared build is statically linked — no glibc/musl concern on any distro.
- Non-root safe: install needs write access to `$HOME` only, never `sudo`.

## Containers (Docker / Kubernetes)

The official base image `ghcr.io/openclaw/openclaw` **does not bundle cloudflared**. The one-click install works inside the container (verified E2E on 2026.10.10, arm64):

```
BEFORE install: cloudflaredInstalled = false
INSTALL result: {"ok":true,"detail":"installed to /tmp/fresh-home/.local/bin/cloudflared"}
AFTER install: cloudflaredInstalled = true
BINARY: cloudflared version 2026.10.7
```

Base image environment (Debian 12 bookworm, non-root uid 1000): `curl`, `tar`, `ps` present; `$HOME/.local/bin` already on `PATH`; `$HOME` writable.

### Caveat: ephemeral filesystems

`~/.local/bin` lives in the container layer — a restarted pod reinstalls the binary on next share. For long-lived deployments, bake it into the image instead:

```dockerfile
FROM ghcr.io/openclaw/openclaw:2026.10.10
USER root
ARG TARGETARCH
RUN curl -fsSL -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${TARGETARCH}" \
    && chmod 755 /usr/local/bin/cloudflared
USER node
```

(`/usr/local/bin/cloudflared` is in the detection candidates, so no other change is needed.)

### Kubernetes

- Tunnel share is a **controller** feature (workers do not run connectors).
- The connector needs **outbound 443** (http2 protocol over TCP; QUIC is deliberately disabled in the spawn args to survive QUIC-blocking networks).
- `tunnel-state.json` (recovery handle) is written under the OS tmpdir (`$TMPDIR/teamclaw-cloudflared-home/`) — mount a volume there if you want share recovery across pod restarts.
- Orphan reaping uses `ps`; on images without it, recovery degrades gracefully (skips reaping, still reconnects).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Install fails with download 404 | stale plugin using the linux `.tgz` URL | upgrade to a release with the raw-binary install (2026.7.0+) |
| Installed but panel still says "not installed" | stale detection (CWD check) | same — upgrade |
| `download: spawn curl ENOENT` | curl-less image, old plugin | upgrade (native fallback now covers this) |
| Connector exits immediately | outbound 443 blocked | open egress; check `cloudflared.log` in `$TMPDIR/teamclaw-cloudflared-home/` |
