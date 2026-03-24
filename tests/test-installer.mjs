#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

async function runInstallerExactPluginVersionSmoke() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "teamclaw-installer-plugin-test-"));
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
printf '%s\n' "$@" > "$TEAMCLAW_CAPTURE_FILE"
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
    assert.deepEqual(
      capturedArgs,
      ["plugins", "install", expectedInstallSpec],
      "installer should request the exact TeamClaw package version during plugin install",
    );

    console.log("Installer exact-version plugin-install smoke passed.");
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

await runInstallerSmoke();
await runInstallerExactPluginVersionSmoke();
