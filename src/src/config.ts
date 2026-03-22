import type { PluginConfig } from "./types.js";
import { parsePluginConfig } from "./types.js";

function buildConfigSchema() {
  return {
    jsonSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string" as const,
          enum: ["controller", "worker"],
          default: "worker",
          description: "Plugin mode: controller manages the team, worker executes tasks",
        },
        port: {
          type: "number" as const,
          default: 9527,
          description: "HTTP server port for this instance",
        },
        role: {
          type: "string" as const,
          default: "developer",
          description: "Worker role (only used in worker mode)",
        },
        controllerUrl: {
          type: "string" as const,
          default: "",
          description: "Manual controller URL fallback (used when mDNS discovery fails)",
        },
        teamName: {
          type: "string" as const,
          default: "default",
          description: "Team name for mDNS identification",
        },
        heartbeatIntervalMs: {
          type: "number" as const,
          default: 10000,
          description: "Heartbeat interval in milliseconds",
        },
      },
    },
    uiHints: {
      mode: { label: "Mode", help: "controller manages the team, worker executes tasks" },
      port: { label: "Port", help: "HTTP server port for this instance" },
      role: { label: "Role", help: "Worker role (worker mode only)" },
      controllerUrl: { label: "Controller URL", help: "Manual fallback if mDNS discovery fails" },
      teamName: { label: "Team Name", help: "Team identifier for mDNS" },
      heartbeatIntervalMs: { label: "Heartbeat Interval", help: "In milliseconds, minimum 1000" },
    },
    parse(raw: unknown): PluginConfig {
      return parsePluginConfig(raw as Record<string, unknown>);
    },
  };
}

export { buildConfigSchema };
