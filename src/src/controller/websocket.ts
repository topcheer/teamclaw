import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import type { PluginLogger } from "../../api.js";

export type WsEvent =
  | { type: "worker:online"; data: unknown }
  | { type: "worker:offline"; data: unknown }
  | { type: "controller:run"; data: unknown }
  | { type: "controller:run_deleted"; data: unknown }
  | { type: "task:created"; data: unknown }
  | { type: "task:updated"; data: unknown }
  | { type: "task:completed"; data: unknown }
  | { type: "task:deleted"; data: unknown }
  | { type: "task:execution"; data: unknown }
  | { type: "message:new"; data: unknown }
  | { type: "clarification:requested"; data: unknown }
  | { type: "clarification:answered"; data: unknown }
  | { type: "clarification:deleted"; data: unknown }
  | { type: "message:deleted"; data: unknown }
  | { type: "project:deleted"; data: unknown }
  | { type: "requirement:complete"; data: unknown }
  | { type: "report:ready"; data: unknown }
  | { type: "teamauto:activity"; data: unknown }
  // Phase 2.2 (design sections 2.3/4): team profile switch lifecycle. Event
  // names follow the design document verbatim (dot-separated) rather than the
  // colon convention used by the domain events above - they are the external
  // contract UI/desktop/workers will subscribe to.
  | { type: "team.switch_started"; data: { profileId: string; previousProfileId: string } }
  | { type: "team.switch_completed"; data: { profileId: string } };

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
