// Issue #226 W2 (route-table carve-up): the controller runs / projects /
// intake route handlers moved verbatim from route-table.ts (PR-D had moved
// them verbatim from http-server.ts before that) - bodies byte-identical,
// only the module home changed. route-table.ts keeps the table entries that
// bind these handlers and re-exports the retry-hint constant for
// http-server.ts's dispatch gates. Like security.ts, this module imports
// route-table.js as TYPE ONLY (RouteContext), so the module graph stays
// acyclic.
import fs from "node:fs";
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { normalizeControllerManifest } from "./orchestration-manifest.js";
import {
  normalizeControllerIntakeSessionKey,
} from "./task-execution.js";
import {
  findLatestControllerRunIdForSession,
  syncProjectRegistryEntry,
} from "./project-registry.js";
import {
  appendControllerRunEvent,
  serializeControllerRun,
  updateControllerRun,
} from "./controller-runs.js";
import {
  deleteControllerRunCascade,
  deleteProjectCascade,
  resolveSafeProjectDirectory,
} from "./task-cleanup.js";
import {
  ControllerIntakeSwitchInProgressError,
  reconcileControllerClarifications,
  runControllerIntake,
} from "./controller-intake.js";
import { buildControllerManifestEventMessage } from "./controller-planning.js";
import {
  buildStartupReadinessMessage,
  shouldBlockControllerUntilProvisioningReady,
} from "./worker-routes.js";
import type { RouteContext } from "./route-table.js";

/**
 * Retry hint shared by the transition-matrix gate (http-server.ts, task
 * submission / repo import) and the intake handler in this module. Lived in
 * route-table.ts since PR-D (the intake handler body carried it in 503
 * bodies); W2 moved it here with its consumer - route-table re-exports it so
 * http-server.ts's gate import is unchanged.
 */
export const SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS = 5;

async function controllerManifestRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  const { logger, getTeamState, updateTeamState, wsServer } = deps;
  const body = await parseJsonBody(req);
  const sessionKey = normalizeControllerIntakeSessionKey(body.sessionKey);
  const manifest = normalizeControllerManifest(body.manifest);
  if (!manifest) {
    sendError(res, 400, "manifest is required and must include requirementSummary");
    return;
  }

  const runId = findLatestControllerRunIdForSession(sessionKey, deps.getTeamState(), {
    preferActive: true,
  });
  if (!runId) {
    sendError(res, 404, "Controller run not found for session");
    return;
  }

  const updatedRun = updateControllerRun(runId, deps, (run) => {
    run.manifest = manifest;
    const state = deps.getTeamState();
    if (state) {
      const project = syncProjectRegistryEntry(state, {
        projectId: manifest.projectName ?? run.projectId,
        projectDir: run.projectDir ?? manifest.projectName,
        aliases: [manifest.projectName, run.projectId],
        summary: manifest.requirementSummary,
        updatedAt: Date.now(),
      });
      run.projectId = project.projectId;
      run.projectDir = project.projectDir;
    }

    if (run.projectDir) {
      const state = deps.getTeamState();
      if (state) {
        for (const taskId of run.createdTaskIds) {
          const task = state.tasks[taskId];
          if (task) {
            if (!task.projectDir) {
              task.projectDir = run.projectDir;
            }
            if (!task.projectId) {
              task.projectId = run.projectId;
            }
          }
        }
      }
    }

    appendControllerRunEvent(run, {
      type: "output",
      phase: "manifest_recorded",
      source: "controller",
      status: "running",
      sessionKey,
      message: buildControllerManifestEventMessage(manifest),
    });
  });

  if (!updatedRun) {
    sendError(res, 404, "Controller run not found");
    return;
  }

  if (manifest.requirementFullyComplete) {
    logger.info(`Controller: requirement fully complete for session ${sessionKey} (run ${runId})`);
    wsServer.broadcastUpdate({
      type: "requirement:complete",
      data: {
        runId,
        sessionKey,
        requirementSummary: manifest.requirementSummary,
      },
    });
  }

  sendJson(res, 201, {
    controllerRun: serializeControllerRun(updatedRun),
    manifest,
  });
}

async function controllerRunsListRoute(ctx: RouteContext): Promise<void> {
  const { res, deps } = ctx;
  const state = reconcileControllerClarifications(deps);
  const controllerRuns = state
    ? Object.values(state.controllerRuns)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((run) => serializeControllerRun(run))
    : [];
  sendJson(res, 200, { controllerRuns });
}

async function projectDeleteRoute(ctx: RouteContext): Promise<void> {
  const { res, pathname, deps } = ctx;
  const projectDir = decodeURIComponent(pathname.split("/").pop()!);
  const result = await deleteProjectCascade(projectDir, deps);
  if (!result.deleted) {
    sendError(res, 404, "Project not found or project cleanup could not be confirmed");
    return;
  }
  const safeProjectPath = resolveSafeProjectDirectory(projectDir);
  const stillExists = safeProjectPath ? fs.existsSync(safeProjectPath) : true;
  if (stillExists) {
    sendError(res, 409, "Project cleanup could not be confirmed");
    return;
  }
  sendJson(res, 200, {
    status: "deleted",
    confirmed: true,
    projectDir,
    cleanup: result.summary,
  });
}

async function controllerRunDeleteRoute(ctx: RouteContext): Promise<void> {
  const { res, pathname, deps } = ctx;
  const { getTeamState } = deps;
  const runId = pathname.split("/").pop()!;
  const result = await deleteControllerRunCascade(runId, deps);
  if (!result.deleted) {
    sendError(res, 404, "Controller run not found");
    return;
  }
  const stillExists = !!getTeamState()?.controllerRuns[runId];
  if (stillExists) {
    sendError(res, 409, "Planning run cleanup could not be confirmed");
    return;
  }
  sendJson(res, 200, {
    status: "deleted",
    confirmed: true,
    runId,
    cleanup: result.summary,
  });
}

async function controllerIntakeRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps, currentState } = ctx;
  const { logger } = deps;
  const readinessGate = shouldBlockControllerUntilProvisioningReady(deps, currentState);
  if (readinessGate.blocked && readinessGate.readiness) {
    sendError(res, 503, buildStartupReadinessMessage(readinessGate.readiness));
    return;
  }
  const body = await parseJsonBody(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    sendError(res, 400, "message is required");
    return;
  }

  const sessionKey = normalizeControllerIntakeSessionKey(body.sessionKey);

  try {
    const result = await runControllerIntake(message, sessionKey, deps);
    sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof ControllerIntakeSwitchInProgressError) {
      // Same response shape as the URL-level transition gate (503 +
      // Retry-After); reachable here when a switch starts between the gate
      // and the intake entry (the gate reads the state once per request).
      res.setHeader("Retry-After", String(SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: err.message,
        retryAfterSeconds: SWITCH_TASK_SUBMISSION_RETRY_AFTER_SECONDS,
        transition: {
          phase: err.transition.phase,
          targetProfileId: err.transition.targetProfileId,
        },
      });
      return;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn(`Controller: intake failed for ${sessionKey}: ${errorMessage}`);
    sendError(res, errorMessage.includes("timed out") ? 504 : 500, errorMessage);
  }
}

export {
  controllerManifestRoute,
  controllerRunsListRoute,
  projectDeleteRoute,
  controllerRunDeleteRoute,
  controllerIntakeRoute,
};
