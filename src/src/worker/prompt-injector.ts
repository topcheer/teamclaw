import type { PluginConfig, WorkerIdentity } from "../types.js";
import { getRole } from "../roles.js";
import { MessageQueue } from "./message-queue.js";

export function createWorkerPromptInjector(
  config: PluginConfig,
  getIdentity: () => WorkerIdentity | null,
  messageQueue: MessageQueue,
) {
  return () => {
    const identity = getIdentity();
    if (!identity) {
      return null;
    }

    const roleDef = getRole(identity.role);
    if (!roleDef) {
      return null;
    }

    const parts: string[] = [];

    // Role context
    parts.push(`## TeamClaw Role: ${roleDef.label} ${roleDef.icon}`);
    parts.push(roleDef.systemPrompt);
    parts.push(`Worker ID: ${identity.workerId}`);
    parts.push(`Controller: ${identity.controllerUrl}`);

    // Pending messages
    const pendingMessages = messageQueue.peek();
    if (pendingMessages.length > 0) {
      parts.push("\n## Pending Team Messages");
      for (const msg of pendingMessages) {
        const fromLabel = msg.fromRole ?? msg.from ?? "unknown";
        const target = msg.to ? ` (to ${msg.to})` : "";
        parts.push(`- [${fromLabel}${target}]: ${msg.content}`);
      }
    }

    return {
      prependSystemContext: parts.join("\n"),
    };
  };
}
