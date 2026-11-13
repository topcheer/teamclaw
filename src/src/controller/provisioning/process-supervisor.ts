// W1 of issue #226 (worker-provisioning god-file split): the local process
// backend, extracted VERBATIM from controller/worker-provisioning.ts
// (ProcessProvisioner + its child-process supervision, gateway entrypoint
// resolution, runtime-extension bootstrap and log attachment). The auth
// profile copy and plugin-root resolution live in provisioning-config.ts /
// plugin-root.ts. Never imports worker-provisioning.ts.
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import type { PluginLogger } from "../../../api.js";
import {
  resolveDefaultOpenClawConfigPath,
  resolveDefaultTeamClawRuntimeRootDir,
} from "../../openclaw-workspace.js";
import type { ProvisionedWorkerRecord } from "../../types.js";
import { pathExists, sanitizePathSegment } from "../../shared/utils.js";
import { copyControllerAuthProfiles } from "../provisioning-config.js";
import {
  resolveBakedTeamClawPluginRootDir,
  resolveCurrentTeamClawPluginRootDir,
} from "./plugin-root.js";
import type { LaunchResult, LaunchSpec, WorkerProvisionerBackend } from "./backend-contract.js";

const PROCESS_TERMINATION_TIMEOUT_MS = 10_000;

export class ProcessProvisioner implements WorkerProvisionerBackend {
  readonly type = "process" as const;
  private readonly logger: PluginLogger;
  private readonly processByWorkerId = new Map<string, ChildProcess>();
  private baseDirPromise: Promise<string>; // mutable: ensureBaseDir self-heal swaps it

  constructor(logger: PluginLogger) {
    this.logger = logger;
    const provisionedRoot = path.join(resolveDefaultTeamClawRuntimeRootDir(), "provisioned-workers");
    this.baseDirPromise = fs.mkdir(provisionedRoot, { recursive: true })
      .then(() => fs.mkdtemp(path.join(provisionedRoot, "session-")));
  }

  /**
   * #watchdog (observer-found 2026-11-13, workers starved 2.3h+): the
   * session baseDir is created ONCE in the constructor and cached - if an
   * external cleanup removes it (gateway restarts / culling sweeps), every
   * later launch's mkdtemp hits ENOENT (mkdtemp never creates parents),
   * the provisioner cools down, and pending tasks starve until process
   * restart. Self-heal: verify the cached dir still exists on every
   * launch; on ENOENT, rebuild it and swap the cached promise.
   */
  private async ensureBaseDir(): Promise<string> {
    const dir = await this.baseDirPromise;
    try {
      await fs.stat(dir);
      return dir;
    } catch {
      const provisionedRoot = path.join(resolveDefaultTeamClawRuntimeRootDir(), "provisioned-workers");
      const fresh = fs.mkdir(provisionedRoot, { recursive: true })
        .then(() => fs.mkdtemp(path.join(provisionedRoot, "session-")));
      this.baseDirPromise = fresh;
      this.logger.warn?.(`TeamClaw: provisioner session dir vanished (${dir}) - rebuilt`);
      return fresh;
    }
  }

  async launch(spec: LaunchSpec): Promise<LaunchResult> {
    const baseDir = await this.ensureBaseDir();
    const runtimeHomeDir = await fs.mkdtemp(path.join(baseDir, `${sanitizePathSegment(spec.role)}-`));
    const stateDir = path.join(runtimeHomeDir, ".openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await prepareProcessRuntimeExtensions(stateDir);
    // Issue #237 W4: the bootstrap config carries provider API keys, so it
    // must land owner-only - the default 0644 let any local user read the
    // worker's credentials. { mode } applies at creation; on Windows (no
    // POSIX perms) the option is a no-op and behavior is unchanged.
    // Container backends have the same exposure via the
    // TEAMCLAW_BOOTSTRAP_CONFIG_B64 env (docker inspect / pod env); see the
    // migration note on buildContainerBootstrapScript().
    // Review follow-up (#237): { mode } is creation-only, so an upgrade
    // deployment rewriting a pre-existing 0644 file would keep the loose
    // mode. Explicit chmod of the existing file first (ENOENT tolerated -
    // first write then creates it 0600 via { mode }). Chosen over
    // unlink-then-write to avoid the no-config window mid-rewrite.
    await fs.chmod(configPath, 0o600).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    await fs.writeFile(configPath, spec.configJson, { encoding: "utf8", mode: 0o600 });

    const gatewayEntrypoint = resolveGatewayEntrypoint();
    const child = spawn(process.execPath, [
      gatewayEntrypoint,
      "gateway",
      "--allow-unconfigured",
      "--bind",
      "loopback",
      "--port",
      String(spec.gatewayPort),
    ], {
      cwd: path.dirname(gatewayEntrypoint),
      env: {
        ...process.env,
        ...spec.env,
        HOME: runtimeHomeDir,
        OPENCLAW_HOME: runtimeHomeDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        TEAMCLAW_WORKER_ID: spec.workerId,
        TEAMCLAW_LAUNCH_TOKEN: spec.launchToken,
        ...(spec.workspaceDir ? { TEAMCLAW_WORKSPACE_DIR: spec.workspaceDir } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.processByWorkerId.set(spec.workerId, child);
    attachChildLogs(child, this.logger, `ProvisionedWorker[${spec.role}]`);
    child.on("exit", (code: number | null, signal: string | null) => {
      this.processByWorkerId.delete(spec.workerId);
      this.logger.info(
        `Provisioner: process worker ${spec.workerId} exited (code=${String(code)}, signal=${String(signal)})`,
      );
    });

    return {
      instanceId: child.pid ? `pid:${child.pid}` : undefined,
      instanceName: spec.workerId,
      runtimeHomeDir,
    };
  }

  async terminate(record: ProvisionedWorkerRecord): Promise<void> {
    const child = this.processByWorkerId.get(record.workerId);
    if (child) {
      await stopChildProcess(child);
      this.processByWorkerId.delete(record.workerId);
    } else if (record.instanceId?.startsWith("pid:")) {
      const pid = Number(record.instanceId.slice("pid:".length));
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // ignore
        }
      }
    }

    if (record.runtimeHomeDir) {
      await fs.rm(record.runtimeHomeDir, { recursive: true, force: true }).catch(() => {
        // ignore
      });
    }
  }

  async stop(): Promise<void> {
    for (const child of this.processByWorkerId.values()) {
      await stopChildProcess(child).catch(() => {
        // ignore
      });
    }
    this.processByWorkerId.clear();
  }
}

async function prepareProcessRuntimeExtensions(stateDir: string): Promise<void> {
  const runtimeExtensionsDir = path.join(stateDir, "extensions");
  const controllerExtensionsDir = path.join(path.dirname(resolveDefaultOpenClawConfigPath()), "extensions");
  if (await pathExists(controllerExtensionsDir)) {
    await fs.symlink(controllerExtensionsDir, runtimeExtensionsDir, "dir");
  } else {
    await fs.mkdir(runtimeExtensionsDir, { recursive: true });
    // Baked-in images set TEAMCLAW_BAKED_IN=true and the legacy helper
    // returned "" for that case, so the symlink target was empty and
    // process workers fell back to resolving the plugin from their cwd
    // ("/app/dist/openclaw.plugin.json" not found → exit loop, k3s e2e
    // 2026-11-03). Probe the baked image layout instead: the controller
    // entrypoint (process.argv[1], e.g. /app/dist/index.js) sits below
    // the app root, where the runtime image ships
    // /app/extensions/teamclaw with its openclaw.plugin.json.
    const pluginRootDir = process.env.TEAMCLAW_BAKED_IN === "true"
      ? await resolveBakedTeamClawPluginRootDir()
      : resolveCurrentTeamClawPluginRootDir();
    if (pluginRootDir) {
      await fs.symlink(pluginRootDir, path.join(runtimeExtensionsDir, "teamclaw"), "dir");
    }
  }

  await copyControllerAuthProfiles(stateDir);
}

function resolveGatewayEntrypoint(): string {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Unable to resolve OpenClaw gateway entrypoint");
  }
  return path.resolve(scriptPath);
}

function attachChildLogs(child: ChildProcess, logger: PluginLogger, prefix: string): void {
  if (child.stdout) {
    const stdoutReader = readline.createInterface({ input: child.stdout });
    stdoutReader.on("line", (line: string) => {
      logger.info(`${prefix}: ${line}`);
    });
  }
  if (child.stderr) {
    const stderrReader = readline.createInterface({ input: child.stderr });
    stderrReader.on("line", (line: string) => {
      logger.warn(`${prefix}: ${line}`);
    });
  }
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      resolve();
    }, PROCESS_TERMINATION_TIMEOUT_MS);
    const timer = timeout as unknown as { unref?: () => void };
    timer.unref?.();

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}
