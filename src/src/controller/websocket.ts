import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { PluginLogger } from "../../api.js";

export type WsEvent =
  | { type: "worker:online"; data: unknown }
  | { type: "worker:offline"; data: unknown }
  | { type: "task:created"; data: unknown }
  | { type: "task:updated"; data: unknown }
  | { type: "task:completed"; data: unknown }
  | { type: "message:new"; data: unknown };

export class TeamWebSocketServer {
  private wss: WebSocketServer | null = null;
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      this.logger.info("WebSocket: client connected");
      ws.on("close", () => {
        this.logger.info("WebSocket: client disconnected");
      });
    });

    this.wss.on("error", (err) => {
      this.logger.warn(`WebSocket: error: ${String(err)}`);
    });
  }

  broadcastUpdate(event: WsEvent): void {
    if (!this.wss) return;

    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  close(): void {
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }
  }

  getClientCount(): number {
    return this.wss ? this.wss.clients.size : 0;
  }
}
