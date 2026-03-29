import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const MANAGED_GATEWAY_PARENT_CHECK_INTERVAL_MS = 5_000;
const MANAGED_GATEWAY_PARENT_EXIT_GRACE_MS = 5_000;

export type ManagedGatewaySpawnOptions = {
  gatewayEntrypoint: string;
  gatewayPort: number;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
};

export type ManagedCommandSpawnOptions = {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
};

export function spawnManagedGatewayProcess(options: ManagedGatewaySpawnOptions): ChildProcess {
  const gatewayEntrypoint = path.resolve(options.gatewayEntrypoint);
  const cwd = options.cwd ?? path.dirname(gatewayEntrypoint);
  const child = spawn(process.execPath, buildManagedGatewayWrapperArgs(gatewayEntrypoint, options.gatewayPort), {
    ...buildManagedProcessSpawnOptions({
      cwd,
      env: options.env,
      stdio: options.stdio,
    }),
  });
  attachSpawnErrorGuard(child, "managed-gateway");
  return child;
}

export function spawnManagedCommandProcess(options: ManagedCommandSpawnOptions): ChildProcess {
  const cwd = options.cwd ?? process.cwd();
  const child = spawn(process.execPath, buildManagedCommandWrapperArgs(options.command), {
    ...buildManagedProcessSpawnOptions({
      cwd,
      env: options.env,
      stdio: options.stdio,
    }),
  });
  attachSpawnErrorGuard(child, "managed-command");
  return child;
}

/**
 * Prevent uncaught exception when spawn fails (e.g. ENOENT for missing cwd/binary).
 * Without this guard, Node.js emits the error on process.nextTick which crashes the host.
 */
function attachSpawnErrorGuard(child: ChildProcess, label: string): void {
  child.on("error", (err) => {
    console.error(`[teamclaw] spawn ${label} failed: ${err.message}`);
  });
}

export async function stopManagedProcess(
  child: ChildProcess,
  timeoutMs: number,
  onForceKill?: () => void,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        onForceKill?.();
        signalManagedProcessPid(child.pid, "SIGKILL");
      }
      finish();
    }, timeoutMs);
    timeout.unref?.();

    child.once("exit", () => {
      clearTimeout(timeout);
      finish();
    });

    signalManagedProcessPid(child.pid, "SIGTERM");
  });
}

export async function stopManagedGatewayProcess(
  child: ChildProcess,
  timeoutMs: number,
  onForceKill?: () => void,
): Promise<void> {
  await stopManagedProcess(child, timeoutMs, onForceKill);
}

export function signalManagedProcessPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || !Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct PID when the wrapper process is already gone or the platform rejects group signaling.
    }
  }

  try {
    process.kill(pid, signal);
  } catch {
    // Best-effort cleanup only.
  }
}

export function signalManagedGatewayPid(pid: number | undefined, signal: NodeJS.Signals): void {
  signalManagedProcessPid(pid, signal);
}

function buildManagedProcessSpawnOptions(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
}): SpawnOptions {
  return {
    cwd: options.cwd,
    env: {
      ...options.env,
      TEAMCLAW_PARENT_PID: String(process.pid),
      TEAMCLAW_PARENT_CHECK_INTERVAL_MS: String(MANAGED_GATEWAY_PARENT_CHECK_INTERVAL_MS),
      TEAMCLAW_PARENT_EXIT_GRACE_MS: String(MANAGED_GATEWAY_PARENT_EXIT_GRACE_MS),
    },
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  };
}

function buildManagedGatewayWrapperArgs(gatewayEntrypoint: string, gatewayPort: number): string[] {
  const wrapperScript = String.raw`
const { spawn } = require("node:child_process");

const gatewayEntrypoint = process.argv[1];
const gatewayPort = process.argv[2];
const parentPid = Number(process.env.TEAMCLAW_PARENT_PID || "0");
const parentCheckIntervalMs = Number(process.env.TEAMCLAW_PARENT_CHECK_INTERVAL_MS || "5000");
const parentExitGraceMs = Number(process.env.TEAMCLAW_PARENT_EXIT_GRACE_MS || "5000");
const shutdownSignals = process.platform === "win32"
  ? ["SIGTERM", "SIGINT", "SIGBREAK"]
  : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];

let shuttingDown = false;
let parentMonitor = null;

const child = spawn(process.execPath, [
  gatewayEntrypoint,
  "gateway",
  "--allow-unconfigured",
  "--bind",
  "loopback",
  "--port",
  gatewayPort,
], {
  env: process.env,
  stdio: "inherit",
});

function stopChild(signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (parentMonitor) {
    clearInterval(parentMonitor);
    parentMonitor = null;
  }
  stopChild("SIGTERM");
  const timeout = setTimeout(() => {
    stopChild("SIGKILL");
  }, parentExitGraceMs);
  timeout.unref?.();
  child.once("exit", () => {
    clearTimeout(timeout);
    process.exit(0);
  });
}

if (parentPid > 1) {
  parentMonitor = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown();
    }
  }, parentCheckIntervalMs);
  parentMonitor.unref?.();
}

for (const signal of shutdownSignals) {
  process.once(signal, shutdown);
}

process.once("exit", () => {
  stopChild("SIGTERM");
});

child.once("exit", (code, signal) => {
  if (parentMonitor) {
    clearInterval(parentMonitor);
    parentMonitor = null;
  }
  if (shuttingDown) {
    process.exit(code === null ? 0 : code);
    return;
  }
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
`;

  return ["-e", wrapperScript, gatewayEntrypoint, String(gatewayPort)];
}

function buildManagedCommandWrapperArgs(command: string): string[] {
  const wrapperScript = String.raw`
const { spawn } = require("node:child_process");

const command = process.argv[1];
const parentPid = Number(process.env.TEAMCLAW_PARENT_PID || "0");
const parentCheckIntervalMs = Number(process.env.TEAMCLAW_PARENT_CHECK_INTERVAL_MS || "5000");
const parentExitGraceMs = Number(process.env.TEAMCLAW_PARENT_EXIT_GRACE_MS || "5000");
const shutdownSignals = process.platform === "win32"
  ? ["SIGTERM", "SIGINT", "SIGBREAK"]
  : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
const shell = process.platform === "win32" ? "cmd.exe" : "sh";
const shellArgs = process.platform === "win32"
  ? ["/d", "/s", "/c", command]
  : ["-lc", command];

let shuttingDown = false;
let parentMonitor = null;

const child = spawn(shell, shellArgs, {
  env: process.env,
  stdio: "inherit",
});

function stopChild(signal) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // ignore
  }
}

function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (parentMonitor) {
    clearInterval(parentMonitor);
    parentMonitor = null;
  }
  stopChild("SIGTERM");
  const timeout = setTimeout(() => {
    stopChild("SIGKILL");
  }, parentExitGraceMs);
  timeout.unref?.();
  child.once("exit", () => {
    clearTimeout(timeout);
    process.exit(0);
  });
}

if (parentPid > 1) {
  parentMonitor = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown();
    }
  }, parentCheckIntervalMs);
  parentMonitor.unref?.();
}

for (const signal of shutdownSignals) {
  process.once(signal, shutdown);
}

process.once("exit", () => {
  stopChild("SIGTERM");
});

child.once("exit", (code, signal) => {
  if (parentMonitor) {
    clearInterval(parentMonitor);
    parentMonitor = null;
  }
  if (shuttingDown) {
    process.exit(code === null ? 0 : code);
    return;
  }
  process.exit(code === null ? (signal ? 1 : 0) : code);
});
`;

  return ["-e", wrapperScript, command];
}
