// PR-C of issue #204 (http-server monolith split): the worker message
// delivery helpers extracted verbatim from controller/http-server.ts. Zero
// behavior change. This module must NEVER import http-server (the reverse
// edge exists: http-server -> message-delivery); the router and state getter
// arrive through the deps slice below. Kept separate from the higher-level
// message ROUTES because the controller-planning intake glue also delivers
// messages and must stay below the route layer.
import type { TeamMessage, WorkerInfo } from "../types.js";
import type { ControllerTaskDomainDeps } from "./task-execution.js";

export async function deliverMessageToWorker(
  worker: WorkerInfo,
  message: TeamMessage,
  deps: ControllerTaskDomainDeps,
): Promise<void> {
  const res = await fetch(`${worker.url}/api/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    throw new Error(`worker ${worker.id} responded with ${res.status}`);
  }
}

export async function routeDirectMessage(
  message: TeamMessage,
  deps: ControllerTaskDomainDeps,
): Promise<boolean> {
  const { getTeamState, logger, messageRouter } = deps;
  const state = getTeamState();
  if (!state) {
    return false;
  }

  const routed = messageRouter.routeDirectMessage(message, state.workers);
  if (!routed) {
    return false;
  }

  try {
    await deliverMessageToWorker(routed.worker, routed.message, deps);
  } catch (err) {
    logger.warn(`Controller: failed to deliver message to ${routed.worker.id}: ${String(err)}`);
  }

  return true;
}
