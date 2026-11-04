#!/usr/bin/env node
// DEPRECATED: the runtime image builds FROM the official openclaw base
// (Dockerfile.teamclaw, PR #98). This from-source prepare script is no
// longer referenced by any workflow and is kept for archaeology only.

import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPLACEMENTS = [
  {
    // The upstream tree ships a dangling .claude/skills symlink; the
    // full-tree chmod find dies on it ("cannot operate on dangling
    // symlink"). Skip .claude entirely at copy time AND make the find
    // immune to any other dangling symlinks the tree may grow.
    needle: "RUN find /app -path /app/node_modules -prune -o -exec chmod a+rX {} +",
    replacement: "RUN find /app -path /app/node_modules -prune -o -xtype l -prune -o -exec chmod a+rX {} +",
  },
  {
    // Upstream 2026.10.10 rebuilt the plugin pipeline around
    // docker-plugin-selection.mjs: an empty selection keeps only
    // provider-matched plugins, which would prune teamclaw out of the
    // image. Default the build-arg to our plugin id (the old inline loop
    // is gone).
    needle: 'ARG OPENCLAW_EXTENSIONS=""',
    replacement: 'ARG OPENCLAW_EXTENSIONS="teamclaw"',
  },
  {
    needle: "NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile",
    replacement: "NODE_OPTIONS=--max-old-space-size=2048 pnpm install --no-frozen-lockfile",
  },
  // Upstream 2026.10.10 removed the inline pnpm prune step (replaced by
  // scripts/prune-docker-plugin-dist.mjs after the build) and the hard
  // matrix-sdk-crypto addon gate - both needles and their patches are
  // obsolete.
  {
    // The submodule pin tracks a release tag while the Dockerfile rolls with
    // upstream main; patchedDependencies occasionally references packages a
    // pinned manifest subset no longer resolves, which ERR_PNPM_UNUSED_PATCH
    // fails hard on. Container builds only need the resolvable subset.
    needle: "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./",
    replacement: `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.pnpm=p.pnpm||{};p.pnpm.allowUnusedPatches=true;fs.writeFileSync('package.json',JSON.stringify(p,null,2))"`,
  },
  {
    needle: "COPY . .\n",
    replacement: `COPY . .

# Re-run install after the full workspace lands in the image so built-in
# extension/runtime dependencies added outside the cached manifest subset are
# linked into node_modules before build:docker runs.
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \\
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --no-frozen-lockfile
`,
  },
  {
    needle: "RUN install -d -m 0755 \"$COREPACK_HOME\" && \\\n",
    replacement: `RUN install -d -m 0755 "$COREPACK_HOME" && \\
    install -d -o node -g node /workspace-root && \\
`,
  },
  {
    needle: "RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \\\n",
    replacement: `RUN arch="$(dpkg --print-architecture)" && \\
    case "$arch" in \\
      amd64) kubectlArch=amd64 ;; \\
      arm64) kubectlArch=arm64 ;; \\
      armhf) kubectlArch=arm ;; \\
      *) echo "Unsupported kubectl architecture: $arch" >&2; exit 1 ;; \\
    esac && \\
    kubectlVersion="$(curl -fsSL https://dl.k8s.io/release/stable.txt)" && \\
    curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/\${kubectlVersion}/bin/linux/\${kubectlArch}/kubectl" && \\
    curl -fsSLo /tmp/kubectl.sha256 "https://dl.k8s.io/release/\${kubectlVersion}/bin/linux/\${kubectlArch}/kubectl.sha256" && \\
    checksum="$(cat /tmp/kubectl.sha256)" && \\
    echo "\${checksum}  /tmp/kubectl" | sha256sum -c - && \\
    install -m 0755 /tmp/kubectl /usr/local/bin/kubectl && \\
    rm -f /tmp/kubectl /tmp/kubectl.sha256 && \\
    npm install --global --omit=dev --no-fund --no-audit clawhub && \\
    ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \\
`,
  },
];

const SKIP_BASENAMES = new Set([
  ".git",
  ".claude",
  "node_modules",
  "dist",
  ".next",
  ".turbo",
]);

function parseArgs(argv) {
  let outputDir = "";
  let githubOutput = process.env.GITHUB_OUTPUT || "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a path");
      }
      outputDir = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--github-output") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--github-output requires a path");
      }
      githubOutput = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    outputDir,
    githubOutput,
  };
}

function shouldCopy(sourcePath) {
  return !SKIP_BASENAMES.has(path.basename(sourcePath));
}

function writeGithubOutputs(filePath, outputs) {
  if (!filePath) {
    return;
  }
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const { outputDir, githubOutput } = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, "..");
  const openclawSourceDir = path.join(repoRoot, "openclaw");
  const extensionSourceDir = path.join(repoRoot, "src");

  const buildRoot = outputDir || await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-runtime-context-"));
  const contextDir = path.join(buildRoot, "openclaw");
  const dockerfilePath = path.join(contextDir, "Dockerfile.teamclaw");
  const extensionTargetDir = path.join(contextDir, "extensions", "teamclaw");

  await fs.mkdir(buildRoot, { recursive: true });
  await fs.rm(contextDir, { recursive: true, force: true });

  await fs.cp(openclawSourceDir, contextDir, {
    recursive: true,
    force: true,
    filter: (sourcePath) => shouldCopy(sourcePath),
  });

  await fs.rm(extensionTargetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(extensionTargetDir), { recursive: true });
  await fs.cp(extensionSourceDir, extensionTargetDir, {
    recursive: true,
    force: true,
    filter: (sourcePath) => shouldCopy(sourcePath),
  });

  // The plugin ships a pinned "openclaw": "<exact>" dependency, but inside
  // the image build it is a member of the upstream pnpm workspace whose root
  // is the submodule-pinned version - an exact pin that differs from the
  // root (e.g. plugin 2026.10.9 vs workspace 2026.10.10) resolves to
  // nothing and fails the prod install with ERR_PNPM_NO_MATURE_MATCHING_
  // VERSION. Rewrite it to the workspace protocol so the plugin always
  // links whatever runtime the image actually builds.
  const extensionPackageJsonPath = path.join(extensionTargetDir, "package.json");
  const extensionPackageJson = JSON.parse(await fs.readFile(extensionPackageJsonPath, "utf8"));
  if (extensionPackageJson.dependencies && typeof extensionPackageJson.dependencies.openclaw === "string") {
    extensionPackageJson.dependencies.openclaw = "workspace:*";
    await fs.writeFile(extensionPackageJsonPath, `${JSON.stringify(extensionPackageJson, null, 2)}\n`, "utf8");
  }

  let dockerfileSource = await fs.readFile(path.join(contextDir, "Dockerfile"), "utf8");
  for (const { needle, replacement } of REPLACEMENTS) {
    if (!dockerfileSource.includes(needle)) {
      throw new Error(`Expected Dockerfile command not found: ${needle}`);
    }
    // replaceAll: upstream 2026.10.10 carries the SAME install command in
    // TWO stages (production-deps and build); a single replace patched only
    // the first occurrence and the build stage kept --frozen-lockfile
    // (ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER, three burned CI runs).
    dockerfileSource = dockerfileSource.replaceAll(needle, replacement);
  }
  // Output guards: the patched Dockerfile MUST carry our semantic changes.
  // If an upstream edit silently no-ops a replacement (or a cache/checkout
  // oddity serves a stale file), fail here with a precise message instead
  // of a cryptic pnpm error twenty minutes later.
  for (const marker of ['OPENCLAW_EXTENSIONS="teamclaw"', "--no-frozen-lockfile"]) {
    if (!dockerfileSource.includes(marker)) {
      throw new Error(`patched Dockerfile is missing ${marker} - replacement no-oped or stale source`);
    }
  }
  await fs.writeFile(dockerfilePath, dockerfileSource, "utf8");

  const result = {
    buildRoot,
    contextDir,
    dockerfilePath,
    extensionTargetDir,
  };

  console.log(JSON.stringify(result, null, 2));
  writeGithubOutputs(githubOutput, {
    build_root: result.buildRoot,
    context_dir: result.contextDir,
    dockerfile_path: result.dockerfilePath,
    extension_target_dir: result.extensionTargetDir,
  });
}

main().catch((error) => {
  console.error(
    `Failed to prepare TeamClaw runtime build context: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
