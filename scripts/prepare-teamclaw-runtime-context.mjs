#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPLACEMENTS = [
  {
    needle: "for ext in $OPENCLAW_EXTENSIONS; do \\\n",
    replacement: "for ext in $(find /tmp/extensions -mindepth 1 -maxdepth 1 -type d -exec basename {} \\\\;); do \\\n",
  },
  {
    needle: "NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile",
    replacement: "NODE_OPTIONS=--max-old-space-size=2048 pnpm install --no-frozen-lockfile",
  },
  {
    needle: "CI=true pnpm prune --prod",
    replacement: "true",
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

  let dockerfileSource = await fs.readFile(path.join(contextDir, "Dockerfile"), "utf8");
  for (const { needle, replacement } of REPLACEMENTS) {
    if (!dockerfileSource.includes(needle)) {
      throw new Error(`Expected Dockerfile command not found: ${needle}`);
    }
    dockerfileSource = dockerfileSource.replace(needle, replacement);
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
