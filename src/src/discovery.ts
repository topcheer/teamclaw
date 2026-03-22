import type { PluginLogger } from "../api.js";
import type { DiscoveryResult } from "./types.js";
import { MDNS_TYPE } from "./protocol.js";

export class MDnsAdvertiser {
  private service: InstanceType<typeof import("bonjour-service").default> | null = null;
  private advertisement: ReturnType<InstanceType<typeof import("bonjour-service").default>["publish"]> | null = null;
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  async start(port: number, teamName: string): Promise<void> {
    try {
      const Bonjour = (await import("bonjour-service")).default;
      this.service = new Bonjour();
      this.advertisement = this.service.publish({
        name: `teamclaw-${teamName}-controller`,
        type: MDNS_TYPE,
        port,
        txt: { teamName },
      });
      this.logger.info(`mDNS: advertising teamclaw controller on port ${port}`);
    } catch (err) {
      this.logger.warn(`mDNS: failed to start advertising: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  stop(): void {
    if (this.advertisement) {
      this.advertisement.stop();
      this.advertisement = null;
    }
    if (this.service) {
      this.service.destroy();
      this.service = null;
    }
  }
}

export class MDnsBrowser {
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  async browse(teamName?: string, timeoutMs = 5000): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];
    try {
      const Bonjour = (await import("bonjour-service")).default;
      const bonjour = new Bonjour();

      await new Promise<void>((resolve) => {
        const browser = bonjour.find({
          type: MDNS_TYPE,
          ...(teamName ? { txt: { teamName } } : {}),
        });

        const timer = setTimeout(() => {
          browser.stop();
          bonjour.destroy();
          resolve();
        }, timeoutMs);

        browser.on("up", (service) => {
          const txtRecord = service.txt as Record<string, string> | undefined;
          const svcTeamName = txtRecord?.teamName ?? "default";
          const host = Array.isArray(service.addresses) && service.addresses.length > 0
            ? service.addresses[0]
            : (service.host ?? "localhost");
          const port = typeof service.port === "number" ? service.port : 9527;

          results.push({
            name: service.name ?? "unknown",
            host,
            port,
            teamName: svcTeamName,
          });

          this.logger.info(`mDNS: found controller at ${host}:${port} (team: ${svcTeamName})`);

          // Found at least one result, stop browsing
          clearTimeout(timer);
          browser.stop();
          bonjour.destroy();
          resolve();
        });

        browser.on("error", (err) => {
          this.logger.warn(`mDNS: browse error: ${String(err)}`);
        });
      });
    } catch (err) {
      this.logger.warn(`mDNS: failed to browse: ${err instanceof Error ? err.message : String(err)}`);
    }

    return results;
  }
}
