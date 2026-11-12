// Controller activity journal (#ui-blindness): an in-memory ring of recent
// controller-side events, plus a tail reader for the teamclaw-relevant slice
// of the host gateway log. The web UI's Activity tab polls the journal and
// follows the log tail so operators can SEE provisioning, sweeps, task
// routing and tunnel lifecycle without ssh-ing into logs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "../protocol.js";

// Structural event shape (deliberately NOT importing the WsEvent type from
// websocket.js: journal <- websocket is fine, but websocket -> journal for
// the broadcast hook would make the pair a cycle under the arch gate. Keep
// this module leaf-level.)
type BroadcastLike = { type?: unknown; data?: unknown };

export type JournalEntry = {
  at: number;
  source: "ws" | "provisioner";
  type: string;
  summary: string;
};

const RING_LIMIT = 400;
const ring: JournalEntry[] = [];

/** Record a controller event into the ring (callers also broadcast it). */
export function journalRecord(source: JournalEntry["source"], type: string, summary: string): void {
  ring.push({ at: Date.now(), source, type, summary: summary.slice(0, 240) });
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
}

/** Summarize a broadcast WS event into the journal (best effort, never throws). */
export function journalFromWsEvent(event: BroadcastLike): void {
  try {
    const t = String(event.type ?? "unknown");
    if (t === "task:created" || t === "task:completed" || t === "task:updated" || t === "worker:online" || t === "worker:offline" || t === "team:config_updated" || t === "controller:run") {
      journalRecord("ws", t, JSON.stringify(event.data ?? {}).slice(0, 200));
    }
  } catch { /* journal must never break broadcasting */ }
}

export function journalSnapshot(limit = 200): JournalEntry[] {
  return ring.slice(-Math.min(limit, RING_LIMIT));
}

// ---------------------------------------------------------------------------
// Host gateway log tail (read-only). The teamclaw plugin logs land in the
// openclaw gateway log; filter to the teamclaw-relevant lines.
// ---------------------------------------------------------------------------

const TEAMCLAW_LOG_FILTER = /TeamClaw|TeamAuto|Provisioner|ProvisionedWorker|TaskRouter|tunnel|Controller:/i;

function gatewayLogCandidates(): string[] {
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return [
    process.env.TEAMCLAW_GATEWAY_LOG,
    path.join(home, "logs", "gateway.log"),
    path.join(process.env.HOME ?? "", "Library", "Logs", "openclaw", "gateway.log"),
  ].filter((p): p is string => Boolean(p));
}

export function readGatewayLogTail(lines = 200, filter = true): { path: string | null; lines: string[] } {
  for (const candidate of gatewayLogCandidates()) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const all = raw.split("\n").filter((l) => l.trim().length > 0);
      const picked = filter ? all.filter((l) => TEAMCLAW_LOG_FILTER.test(l)) : all;
      return { path: candidate, lines: picked.slice(-lines) };
    } catch {
      // try next candidate
    }
  }
  return { path: null, lines: [] };
}

// Route handlers (bound in route-table.ts, appended at the table tail on the
// append-only precedent; both read-only GETs).
export function controllerJournalRoute({ res, requestUrl }: { res: ServerResponse; requestUrl: URL }): void {
  const limit = Math.min(Math.max(parseInt(requestUrl.searchParams.get("limit") ?? "200", 10) || 200, 1), 400);
  sendJson(res, 200, { events: journalSnapshot(limit) });
}

export function controllerLogTailRoute({ res, requestUrl }: { res: ServerResponse; requestUrl: URL }): void {
  const lines = Math.min(Math.max(parseInt(requestUrl.searchParams.get("lines") ?? "200", 10) || 200, 1), 1000);
  const unfiltered = requestUrl.searchParams.get("all") === "1";
  sendJson(res, 200, readGatewayLogTail(lines, !unfiltered));
}
