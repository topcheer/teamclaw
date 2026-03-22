import type { PluginLogger } from "../../api.js";
import type { TeamMessage, WorkerInfo } from "../types.js";
import { generateId } from "../protocol.js";

export class MessageRouter {
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  routeDirectMessage(
    message: TeamMessage,
    workers: Record<string, WorkerInfo>,
  ): { worker: WorkerInfo; message: TeamMessage } | null {
    if (!message.toRole) return null;

    const targetWorker = Object.values(workers).find(
      (w) => w.role === message.toRole && w.status !== "offline",
    );

    if (!targetWorker) {
      this.logger.warn(`MessageRouter: no worker found for role ${message.toRole}`);
      return null;
    }

    const routedMessage: TeamMessage = {
      ...message,
      id: message.id || generateId(),
      to: targetWorker.id,
      createdAt: message.createdAt || Date.now(),
    };

    return { worker: targetWorker, message: routedMessage };
  }

  routeBroadcast(
    message: TeamMessage,
    workers: Record<string, WorkerInfo>,
  ): Array<{ worker: WorkerInfo; message: TeamMessage }> {
    const activeWorkers = Object.values(workers).filter(
      (w) => w.status !== "offline" && w.id !== message.from,
    );

    return activeWorkers.map((worker) => ({
      worker,
      message: {
        ...message,
        id: generateId(),
        to: worker.id,
        createdAt: message.createdAt || Date.now(),
      },
    }));
  }

  routeReviewRequest(
    message: TeamMessage,
    workers: Record<string, WorkerInfo>,
  ): { worker: WorkerInfo; message: TeamMessage } | null {
    return this.routeDirectMessage(message, workers);
  }
}
