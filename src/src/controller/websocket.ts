import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
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
  | { type: "team:config_updated"; data: unknown }
  | { type: "teamauto:activity"; data: unknown }
  // Phase 2.2 (design sections 2.3/4): team profile switch lifecycle. Event
  // names follow the design document verbatim (dot-separated) rather than the
  // colon convention used by the domain events above - they are the external
  // contract UI/desktop/workers will subscribe to.
  | { type: "team.switch_started"; data: { profileId: string; previousProfileId: string } }
  | { type: "team.switch_completed"; data: { profileId: string } }
  // Phase 2 follow-up (#201 review): the switch failed mid-flight. Broadcast
  // BEFORE the transition is cleared so UI waiters see the failure instead of
  // silently timing out on reconcile. `reason` states the honest worst case:
  // once the step-3 archive write has landed, the team may be partially
  // switched and a restart is the reliable way back to a known-good team.
  | { type: "team.switch_failed"; data: { previousProfileId: string; targetProfileId: string; reason: string } };

/**
 * Issue #23: optional upgrade guard. While device protection is on, the
 * composition root passes a `verifyUpgrade` predicate that validates the
 * upgrade request's device token (query ?token= / cookie / Bearer header,
 * see controller/security.ts createWebSocketUpgradeGuard); returning false
 * makes ws answer the upgrade with 401. Without the option the server is
 * wide open - the pre-issue L0 behavior.
 */
export type TeamWebSocketAttachOptions = {
  verifyUpgrade?: (req: IncomingMessage) => boolean;
};

export class TeamWebSocketServer {
  private wss: WebSocketServer | null = null;
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  attach(server: Server, options?: TeamWebSocketAttachOptions): void {
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      ...(options?.verifyUpgrade ? { verifyClient: (info: { req: IncomingMessage }) => options.verifyUpgrade!(info.req) } : {}),
    });

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
