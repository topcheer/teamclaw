// PR-C of issue #204 (http-server monolith split): the worker lifecycle
// routes (register/heartbeat/delete/list) and the startup provisioning
// readiness gate extracted verbatim from controller/http-server.ts. Zero
// behavior change - the route shells in http-server keep the method+pathname
// matches and call these handlers with the same deps object as before. This
// module must NEVER import http-server (the reverse edge exists:
// http-server -> worker-routes).
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  StartupProvisioningReadiness,
  TeamState,
  WorkerInfo,
} from "../types.js";
import { parseJsonBody, sendError, sendJson } from "../protocol.js";
import {
  getActiveDefaultRole,
  getActiveProfileId,
  getActiveRoleIds,
  validateActiveRoleId,
} from "../profile-loader.js";
import {
  resetTaskForFreshAttempt,
  serializeTask,
  type ControllerTaskDomainDeps,
} from "./task-execution.js";
import { autoAssignPendingTasks, scheduleProvisioningReconcile } from "./task-assignment.js";

// POST /api/v1/workers/register
export async function handleWorkerRegisterRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { logger, updateTeamState, wsServer } = deps;
  const body = await parseJsonBody(req);
  const workerId = typeof body.workerId === "string" ? body.workerId : "";
  const rawRole = typeof body.role === "string" ? body.role.trim() : "";
  const role = validateActiveRoleId(rawRole) ?? "";
  const label = typeof body.label === "string" ? body.label : role;
  const workerUrl = typeof body.url === "string" ? body.url : "";
  const capabilities = Array.isArray(body.capabilities) ? body.capabilities as string[] : [];
  const launchToken = typeof body.launchToken === "string" ? body.launchToken : undefined;

  if (!workerId || !role || !workerUrl) {
    // Issue #192: a role string that the ACTIVE profile does not know is
    // the actionable failure (worker config carried an id from another
    // profile, or the team switched profiles underneath the worker) - say
    // so with the valid id list instead of the generic "required" 400.
    if (workerId && !role && workerUrl && rawRole) {
      sendError(
        res,
        400,
        `role "${rawRole}" is not part of the active team profile "${getActiveProfileId()}" (valid roles: ${getActiveRoleIds().join(", ")}). ` +
          "Update the worker's role config to one of these roles, or have the controller switch the team profile.",
      );
      return;
    }
    sendError(res, 400, "workerId, role, and url are required");
    return;
  }

  const registrationValidation = deps.workerProvisioningManager?.validateRegistration(workerId, role, launchToken);
  if (registrationValidation && !registrationValidation.ok) {
    sendError(res, 403, registrationValidation.reason ?? "Worker registration rejected");
    return;
  }

  const state = updateTeamState((s) => {
    s.workers[workerId] = {
      id: workerId,
      role,
      label,
      status: "idle",
      transport: "http",
      url: workerUrl,
      lastHeartbeat: Date.now(),
      capabilities,
      registeredAt: Date.now(),
    };
  });
  deps.workerProvisioningManager?.onWorkerRegistered(workerId);

  wsServer.broadcastUpdate({ type: "worker:online", data: state.workers[workerId] });
  logger.info(`Controller: worker registered - ${label} (${workerId}) at ${workerUrl}`);
  sendJson(res, 201, { status: "registered", worker: state.workers[workerId] });
  void autoAssignPendingTasks(deps, workerId).catch((err) => {
    logger.warn(`Controller: failed to auto-assign after worker registration (${workerId}): ${String(err)}`);
  });
}

// DELETE /api/v1/workers/:id
export async function handleWorkerDeleteRequest(deps: ControllerTaskDomainDeps, res: ServerResponse, pathname: string): Promise<void> {
  const { logger, getTeamState, updateTeamState, wsServer } = deps;
  const workerId = pathname.split("/").pop()!;
  if (deps.workerProvisioningManager?.hasManagedWorker(workerId)) {
    await deps.workerProvisioningManager.onWorkerRemoved(workerId, "worker delete requested");
  }

  const affectedTaskIds: string[] = [];
  updateTeamState((s) => {
    const worker = s.workers[workerId];
    if (worker) {
      worker.status = "offline";
      worker.currentTaskId = undefined;
      delete s.workers[workerId];
    }

    for (const task of Object.values(s.tasks)) {
      if (
        task.assignedWorkerId === workerId &&
        task.status !== "completed" &&
        task.status !== "failed" &&
        task.status !== "blocked"
      ) {
        task.status = "pending";
        task.assignedWorkerId = undefined;
        resetTaskForFreshAttempt(task);
        task.updatedAt = Date.now();
        affectedTaskIds.push(task.id);
      }
    }
  });

  await autoAssignPendingTasks(deps);
  for (const taskId of affectedTaskIds) {
    const task = getTeamState()?.tasks[taskId];
    if (task) {
      wsServer.broadcastUpdate({ type: "task:updated", data: serializeTask(task) });
    }
  }
  wsServer.broadcastUpdate({ type: "worker:offline", data: { workerId } });
  logger.info(`Controller: worker removed - ${workerId}`);
  sendJson(res, 200, { status: "removed" });
}

// GET /api/v1/workers
export async function handleWorkerListRequest(deps: ControllerTaskDomainDeps, res: ServerResponse): Promise<void> {
  const { getTeamState } = deps;
  const state = getTeamState();
  const workers = state
    ? Object.values(state.workers).map((worker) => ({
        ...worker,
        // Ghost rows from previous gateway processes (provisioned workers
        // die with the process they ran in). The controller cleans these on
        // startup; the flag lets the UI mark leftovers as removable.
        staleRemovable: worker.id.startsWith("provisioned-") && worker.status === "offline",
      }))
    : [];
  sendJson(res, 200, { workers });
}

// POST /api/v1/workers/:id/heartbeat
export async function handleWorkerHeartbeatRequest(deps: ControllerTaskDomainDeps, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const { updateTeamState } = deps;
  const workerId = pathname.split("/")[4]!;
  const body = await parseJsonBody(req);
  const status = typeof body.status === "string" ? body.status as WorkerInfo["status"] : "idle";
  const currentTaskId = typeof body.currentTaskId === "string" ? body.currentTaskId : undefined;

  updateTeamState((s) => {
    if (s.workers[workerId]) {
      s.workers[workerId].lastHeartbeat = Date.now();
      s.workers[workerId].status = status;
      s.workers[workerId].currentTaskId = currentTaskId;
    }
  });
  deps.workerProvisioningManager?.onWorkerHeartbeat(workerId, status);

  if (status === "idle") {
    await autoAssignPendingTasks(deps, workerId);
  } else {
    scheduleProvisioningReconcile(deps, `heartbeat:${workerId}:${status}`);
  }
  sendJson(res, 200, { status: "ok" });
}

export function getEffectiveStartupReadiness(
  deps: ControllerTaskDomainDeps,
  state: TeamState | null,
): StartupProvisioningReadiness | null {
  if (!deps.workerProvisioningManager?.isEnabled()) {
    return null;
  }
  // Both branches are already-validated RoleId sources: config roles go
  // through parseRoleList (validateRoleIdList) and the fallback is the
  // active profile's defaultRole — no runtime validation needed here.
  const requiredRoles = deps.config.workerProvisioningRoles.length > 0
    ? [...new Set(deps.config.workerProvisioningRoles)]
    : [getActiveDefaultRole()];
  const readyWorkerIds = requiredRoles
    .map((role) => Object.values(state?.workers ?? {}).find((worker) =>
      worker.role === role && (worker.status === "idle" || worker.status === "busy")
    )?.id)
    .filter((workerId): workerId is string => Boolean(workerId));

  if (readyWorkerIds.length === requiredRoles.length) {
    const recorded = state?.provisioning?.startupReadiness;
    return {
      status: "ready",
      startedAt: recorded?.startedAt ?? state?.createdAt ?? Date.now(),
      checkedAt: Date.now(),
      attempts: recorded?.attempts ?? 0,
      requiredRoles,
      readyWorkerIds,
      message: recorded?.status === "ready"
        ? recorded.message
        : `Startup provisioning ready with ${readyWorkerIds.length} warm worker(s).`,
    };
  }

  return state?.provisioning?.startupReadiness ?? {
    status: "checking",
    startedAt: state?.createdAt ?? Date.now(),
    checkedAt: Date.now(),
    attempts: 0,
    requiredRoles,
    readyWorkerIds,
    message: `Startup provisioning warm-up is still initializing for ${requiredRoles.join(", ")}.`,
  };
}

export function buildStartupReadinessMessage(readiness: StartupProvisioningReadiness): string {
  const requiredRoles = readiness.requiredRoles.length > 0 ? readiness.requiredRoles.join(", ") : "configured startup roles";
  if (readiness.status === "ready") {
    return readiness.message ?? "Startup provisioning is ready.";
  }
  if (readiness.status === "checking") {
    return readiness.message ?? `Startup provisioning is still warming workers for ${requiredRoles}.`;
  }
  return readiness.message ?? `Startup provisioning is degraded for ${requiredRoles}. Check provisioning logs and fix worker startup before retrying.`;
}

export function shouldBlockControllerUntilProvisioningReady(
  deps: ControllerTaskDomainDeps,
  state: TeamState | null,
): { blocked: boolean; readiness: StartupProvisioningReadiness | null } {
  const readiness = getEffectiveStartupReadiness(deps, state);
  if (!readiness) {
    return { blocked: false, readiness: null };
  }
  return {
    blocked: readiness.status !== "ready",
    readiness,
  };
}
