import os from "node:os";
import type { PluginLogger } from "../api.js";
import type { PluginConfig, WorkerIdentity } from "./types.js";
import { generateId, createRegistrationRequest } from "./protocol.js";
import { getRole } from "./roles.js";
import { loadWorkerIdentity, saveWorkerIdentity, clearWorkerIdentity } from "./state.js";
import { MDnsBrowser } from "./discovery.js";

function getLocalIp(targetHost?: string): string {
  if (!targetHost || targetHost === "localhost" || targetHost === "127.0.0.1") {
    return "localhost";
  }

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  return "localhost";
}

export class IdentityManager {
  private config: PluginConfig;
  private logger: PluginLogger;
  private identity: WorkerIdentity | null = null;
  private browser: MDnsBrowser;

  constructor(config: PluginConfig, logger: PluginLogger) {
    this.config = config;
    this.logger = logger;
    this.browser = new MDnsBrowser(logger);
  }

  hasIdentity(): boolean {
    return this.identity !== null;
  }

  getIdentity(): WorkerIdentity | null {
    return this.identity;
  }

  async discoverControllerUrl(): Promise<string | null> {
    if (this.config.controllerUrl) {
      return this.config.controllerUrl;
    }

    const results = await this.browser.browse(this.config.teamName, 5000);
    if (results.length > 0) {
      const controller = results[0]!;
      return `http://${controller.host}:${controller.port}`;
    }

    return null;
  }

  async register(): Promise<WorkerIdentity | null> {
    const requestedWorkerId = process.env.TEAMCLAW_WORKER_ID?.trim() || undefined;
    const launchToken = process.env.TEAMCLAW_LAUNCH_TOKEN?.trim() || undefined;

    const existing = await loadWorkerIdentity();
    if (existing) {
      if (requestedWorkerId && existing.workerId !== requestedWorkerId) {
        await clearWorkerIdentity();
      } else {
        this.identity = existing;
        this.logger.info(`Identity: restored existing identity (workerId=${existing.workerId})`);
        return existing;
      }
    }

    const restored = await loadWorkerIdentity();
    if (restored) {
      this.identity = restored;
      this.logger.info(`Identity: restored existing identity (workerId=${restored.workerId})`);
      return restored;
    }

    const controllerUrl = await this.discoverControllerUrl();
    if (!controllerUrl) {
      this.logger.warn("Identity: no controller found via mDNS or manual URL");
      return null;
    }

    const roleDef = getRole(this.config.role);
    const workerId = requestedWorkerId ?? generateId();
    const localIp = getLocalIp(new URL(controllerUrl).hostname);
    const workerUrl = `http://${localIp}:${this.config.port}`;

    const registration = createRegistrationRequest(
      workerId,
      this.config.role,
      roleDef?.label ?? this.config.role,
      workerUrl,
      roleDef?.capabilities ?? [],
      launchToken,
    );

    try {
      const res = await fetch(`${controllerUrl}/api/v1/workers/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(registration),
      });

      if (!res.ok) {
        const text = await res.text();
        this.logger.error(`Identity: registration failed (${res.status}): ${text}`);
        return null;
      }

      const identity: WorkerIdentity = {
        workerId,
        role: this.config.role,
        controllerUrl,
        registeredAt: Date.now(),
      };

      this.identity = identity;
      await saveWorkerIdentity(identity);
      this.logger.info(`Identity: registered as ${this.config.role} (workerId=${workerId}) at ${controllerUrl}`);
      return identity;
    } catch (err) {
      this.logger.error(`Identity: registration error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async clear(): Promise<void> {
    if (this.identity) {
      try {
        await fetch(`${this.identity.controllerUrl}/api/v1/workers/${this.identity.workerId}`, {
          method: "DELETE",
        });
      } catch {
        // ignore
      }
    }

    this.identity = null;
    await clearWorkerIdentity();
    this.logger.info("Identity: cleared");
  }
}
