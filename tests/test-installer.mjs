#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const cliPath = path.join(projectRoot, "src", "cli.mjs");
const packagePath = path.join(projectRoot, "src", "package.json");

async function readPackageMetadata() {
  return JSON.parse(await fs.readFile(packagePath, "utf8"));
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(undefined));
    server.on("error", reject);
  });
}

async function allocatePort() {
  const server = http.createServer();
  try {
    await listen(server, 0);
    const address = server.address();
    return typeof address === "object" && address ? address.port : 19527;
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function waitForHealthServer(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get(
          {
            host: "127.0.0.1",
            port,
            path: "/api/v1/health",
            headers: {
              Connection: "close",
            },
            agent: false,
          },
          (response) => {
            response.resume();
            response.on("end", resolve);
          },
        );
        request.setTimeout(1_000, () => {
          request.destroy(new Error("request timed out"));
        });
        request.on("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Health server did not start on port ${port}`);
}

async function runInstallerSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-test-"));
  try {
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(tempRoot, "workspace");
    const initialFallbacks = ["google/gemini-2.5-flash", "zai/glm-4.7"];
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: {
            primary: "zai/glm-5-turbo",
            fallbacks: initialFallbacks,
          },
          workspace: workspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {},
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--yes", "--skip-plugin-install"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(typeof updated.agents?.defaults?.model, "object", "agents.defaults.model should remain an object");
    assert.equal(
      updated.agents?.defaults?.model?.primary,
      initialConfig.agents.defaults.model.primary,
      "installer should preserve the existing primary model when --yes keeps defaults",
    );
    assert.deepEqual(
      updated.agents?.defaults?.model?.fallbacks,
      initialFallbacks,
      "installer should preserve existing fallback models",
    );
    assert.equal(
      updated.agents?.defaults?.workspace,
      workspacePath,
      "installer should preserve the existing workspace when --yes keeps defaults",
    );
    assert.equal(updated.plugins?.entries?.teamclaw?.enabled, true, "installer should enable the TeamClaw plugin entry");
    assert.equal(
      updated.plugins?.entries?.teamclaw?.config?.mode,
      "controller",
      "installer should configure the default controller mode for single-local installs",
    );
    assert.deepEqual(
      updated.plugins?.entries?.teamclaw?.config?.localRoles,
      ["architect", "developer", "qa"],
      "installer should keep the default single-local role set",
    );

    console.log("Installer model-preservation smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstallerDedicatedWorkspaceDefaultSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-workspace-default-test-"));
  try {
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const sharedWorkspacePath = path.join(stateDir, "workspace");
    const binDir = path.join(tempRoot, "bin");
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: sharedWorkspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {
          teamclaw: {
            enabled: true,
            config: {
              mode: "controller",
              port: 9527,
              teamName: "default",
              workerProvisioningType: "docker",
              workerProvisioningRoles: ["architect", "developer", "qa"],
              workerProvisioningMaxPerRole: 2,
            },
          },
        },
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/bin/sh
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  echo "simulated restart unavailable" >&2
  exit 1
fi
exit 0
`,
    );

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--skip-plugin-install", "--yes"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer dedicated-workspace smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
    const expectedWorkspacePath = path.join(stateDir, "teamclaw-workspaces", "default");
    assert.equal(
      updated.agents?.defaults?.workspace,
      expectedWorkspacePath,
      "installer should default to a dedicated TeamClaw workspace instead of reusing the existing shared OpenClaw workspace",
    );
    assert.equal(
      updated.plugins?.entries?.teamclaw?.config?.workerProvisioningDockerWorkspaceVolume,
      "",
      "docker installs should default to isolated ephemeral workspaces rather than a reused shared volume",
    );
    assert.equal(
      updated.plugins?.entries?.teamclaw?.config?.workerProvisioningWorkspaceRoot,
      "",
      "docker installs should not configure a persistent workspace root when no workspace volume is requested",
    );

    console.log("Installer dedicated-workspace default smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstallerExactPluginVersionSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-plugin-test-"));
  try {
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(tempRoot, "workspace");
    const binDir = path.join(tempRoot, "bin");
    const capturePath = path.join(tempRoot, "openclaw-args.txt");
    const packageMetadata = await readPackageMetadata();
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: workspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {},
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/bin/sh
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  printf '%s\n' "$@" > "$TEAMCLAW_CAPTURE_FILE"
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  echo "simulated restart unavailable" >&2
  exit 1
fi
exit 0
`,
    );

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--yes"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
          TEAMCLAW_CAPTURE_FILE: capturePath,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer plugin-install smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const capturedArgs = (await fs.readFile(capturePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(capturedArgs[0], "plugins");
    assert.equal(capturedArgs[1], "install");
    assert.match(
      capturedArgs[2] || "",
      /\.tgz$/,
      "installer should prefer a local tarball during plugin install",
    );
    assert.match(
      path.basename(capturedArgs[2] || ""),
      new RegExp(`${packageMetadata.version.replace(/\./g, "\\.")}.*\\.tgz$`),
      "installer tarball should include the current TeamClaw version",
    );

    console.log("Installer tarball-first plugin-install smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstallerExactVersionFallbackSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-plugin-fallback-test-"));
  try {
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(tempRoot, "workspace");
    const binDir = path.join(tempRoot, "bin");
    const capturePath = path.join(tempRoot, "openclaw-args.txt");
    const packageMetadata = await readPackageMetadata();
    const expectedInstallSpec = `${packageMetadata.name}@${packageMetadata.version}`;
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: workspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {},
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/bin/sh
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  printf '%s\n' "$@" > "$TEAMCLAW_CAPTURE_FILE"
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  echo "simulated restart unavailable" >&2
  exit 1
fi
exit 0
`,
    );
    await writeExecutable(
      path.join(binDir, "npm"),
      `#!/bin/sh
if [ "$1" = "pack" ]; then
  echo "simulated npm pack failure" >&2
  exit 1
fi
echo "unexpected npm invocation: $*" >&2
exit 99
`,
    );

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--yes"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
          TEAMCLAW_CAPTURE_FILE: capturePath,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer plugin-install fallback smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const capturedArgs = (await fs.readFile(capturePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(
      capturedArgs,
      ["plugins", "install", expectedInstallSpec],
      "installer should fall back to the exact TeamClaw package version when local packing fails",
    );

    console.log("Installer exact-version fallback smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstallerExistingPluginSkipSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-plugin-skip-test-"));
  try {
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(tempRoot, "workspace");
    const binDir = path.join(tempRoot, "bin");
    const pluginCapturePath = path.join(tempRoot, "plugin-ops.txt");
    const packageMetadata = await readPackageMetadata();
    const existingPluginDir = path.join(stateDir, "extensions", "teamclaw");
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: workspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {},
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(existingPluginDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    await fs.writeFile(
      path.join(existingPluginDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: "teamclaw", version: packageMetadata.version }, null, 2)}\n`,
      "utf8",
    );
    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/bin/sh
if [ "$1" = "plugins" ]; then
  printf '%s\n' "$@" > "$TEAMCLAW_PLUGIN_CAPTURE_FILE"
  exit 99
fi
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  echo "simulated restart unavailable" >&2
  exit 1
fi
exit 0
`,
    );
    await writeExecutable(
      path.join(binDir, "npm"),
      `#!/bin/sh
echo "unexpected npm invocation: $*" >&2
exit 99
`,
    );

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--yes"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
          TEAMCLAW_PLUGIN_CAPTURE_FILE: pluginCapturePath,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer existing-plugin skip smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const pluginOpsExists = await fs.access(pluginCapturePath).then(() => true).catch(() => false);
    assert.equal(
      pluginOpsExists,
      false,
      "installer should not call plugin install/uninstall when the same TeamClaw version is already present",
    );
    assert.match(
      result.stdout,
      new RegExp(`Plugin install: already installed \\(${packageMetadata.version.replace(/\./g, "\\.")}\\)`),
      "installer summary should report that the existing TeamClaw plugin was reused",
    );

    console.log("Installer existing-plugin skip smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstallerExistingPluginUpgradeSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-plugin-upgrade-test-"));
  try {
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(tempRoot, "workspace");
    const binDir = path.join(tempRoot, "bin");
    const pluginCapturePath = path.join(tempRoot, "plugin-ops.txt");
    const existingPluginDir = path.join(stateDir, "extensions", "teamclaw");
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: workspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {},
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.mkdir(existingPluginDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    await fs.writeFile(
      path.join(existingPluginDir, "openclaw.plugin.json"),
      `${JSON.stringify({ id: "teamclaw", version: "2026.3.24-4" }, null, 2)}\n`,
      "utf8",
    );
    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/bin/sh
if [ "$1" = "plugins" ] && [ "$2" = "uninstall" ]; then
  printf 'uninstall %s %s\n' "$3" "$4" >> "$TEAMCLAW_PLUGIN_CAPTURE_FILE"
  exit 0
fi
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  printf 'install %s\n' "$3" >> "$TEAMCLAW_PLUGIN_CAPTURE_FILE"
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  echo "simulated restart unavailable" >&2
  exit 1
fi
exit 0
`,
    );

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--yes"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
          TEAMCLAW_PLUGIN_CAPTURE_FILE: pluginCapturePath,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer existing-plugin upgrade smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const operations = (await fs.readFile(pluginCapturePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.equal(operations[0], "uninstall teamclaw --force", "installer should uninstall an older TeamClaw plugin before reinstalling");
    assert.match(
      operations[1] || "",
      /^install .+\.tgz$/,
      "installer should reinstall TeamClaw from a local tarball after removing the older plugin",
    );

    console.log("Installer existing-plugin upgrade smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runInstallerRestartAndHealthSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-restart-test-"));
  let healthServerProcess;
  try {
    const controllerPort = await allocatePort();
    const stateDir = path.join(tempRoot, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    const workspacePath = path.join(tempRoot, "workspace");
    const binDir = path.join(tempRoot, "bin");
    const pluginCapturePath = path.join(tempRoot, "plugin-args.txt");
    const restartCapturePath = path.join(tempRoot, "restart-args.txt");
    healthServerProcess = spawn(
      process.execPath,
      [
        "-e",
        `
const http = require("node:http");
const port = Number(process.argv[1]);
const server = http.createServer((req, res) => {
  if (req.url === "/api/v1/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", mode: "controller" }));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(port, "127.0.0.1");
        `,
        String(controllerPort),
      ],
      {
        stdio: "ignore",
      },
    );
    await waitForHealthServer(controllerPort);
    const initialConfig = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        port: 18789,
        bind: "lan",
      },
      agents: {
        defaults: {
          model: "openai/gpt-5",
          workspace: workspacePath,
        },
      },
      plugins: {
        enabled: true,
        entries: {
          teamclaw: {
            enabled: true,
            config: {
              mode: "controller",
              port: controllerPort,
            },
          },
        },
      },
    };

    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");
    await writeExecutable(
      path.join(binDir, "openclaw"),
      `#!/bin/sh
if [ "$1" = "plugins" ] && [ "$2" = "install" ]; then
  printf '%s\n' "$@" > "$TEAMCLAW_PLUGIN_CAPTURE_FILE"
  exit 0
fi
if [ "$1" = "gateway" ] && [ "$2" = "restart" ]; then
  printf '%s\n' "$@" > "$TEAMCLAW_RESTART_CAPTURE_FILE"
  exit 0
fi
exit 0
`,
    );

    const result = spawnSync(
      "node",
      [cliPath, "install", "--config", configPath, "--yes"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tempRoot,
          PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
          TEAMCLAW_PLUGIN_CAPTURE_FILE: pluginCapturePath,
          TEAMCLAW_RESTART_CAPTURE_FILE: restartCapturePath,
        },
      },
    );

    if (result.status !== 0) {
      throw new Error(
        `Installer restart/health smoke failed with status ${result.status}.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }

    const restartArgs = (await fs.readFile(restartCapturePath, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(restartArgs, ["gateway", "restart"], "installer should restart the gateway after writing config");
    assert.match(
      result.stdout,
      /Gateway restart: completed via openclaw/,
      "installer summary should report gateway restart",
    );
    assert.match(
      result.stdout,
      new RegExp(`Controller health: ok \\(http://127\\.0\\.0\\.1:${controllerPort}/api/v1/health\\)`),
      "installer summary should report controller health",
    );
    assert.match(
      result.stdout,
      new RegExp(`Open UI \\(local\\): http://127\\.0\\.0\\.1:${controllerPort}/ui`),
      "installer summary should include the local UI URL",
    );

    console.log("Installer restart-and-health smoke passed.");
  } finally {
    if (healthServerProcess && !healthServerProcess.killed) {
      healthServerProcess.kill("SIGTERM");
      await new Promise((resolve) => healthServerProcess.once("exit", () => resolve(undefined)));
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await runInstallerSmoke();
await runInstallerDedicatedWorkspaceDefaultSmoke();
await runInstallerExactPluginVersionSmoke();
await runInstallerExactVersionFallbackSmoke();
await runInstallerExistingPluginSkipSmoke();
await runInstallerExistingPluginUpgradeSmoke();
await runInstallerRestartAndHealthSmoke();
