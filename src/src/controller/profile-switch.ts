// PR-A of issue #204 (http-server monolith split): the team profile switch
// state machine extracted verbatim from controller/http-server.ts. Zero
// behavior change - the POST /api/v1/team/profile route shell and the
// controller startup chain (controller-service.ts) call these functions with
// the same deps object as before. This module must NEVER import http-server
// (the reverse edge exists: http-server -> profile-switch); ws broadcasts,
// state persistence and provisioning all arrive through the deps slice below.
// Issue #226 W4: persistence rides the single write entry (deps.
// updateTeamState) - including the awaited durability barriers this state
// machine needs - instead of independent saveTeamState calls; the update
// contract types are type-only imports from controller-service.js (the
// runtime edge points the other way, so the module graph stays acyclic).
import type { PluginLogger } from "../../api.js";
import type {
  PluginConfig,
  TaskInfo,
  TeamState,
} from "../types.js";
import type {
  TeamStateUpdateHandle,
  TeamStateUpdateOptions,
  UpdateTeamStateFn,
} from "./controller-service.js";
import { archiveTeamState, findTeamSwitchArchive } from "../state.js";
import {
  BUILTIN_PROFILES,
  getActiveProfile,
  hasProfile,
  setActiveProfileId,
} from "../profile-loader.js";
import { ensureControllerGitRepo } from "../git-collaboration.js";
import type { TeamWebSocketServer } from "./websocket.js";
import type { WorkerProvisioningManager } from "./worker-provisioning.js";
import type { PreviewManager } from "./preview-manager.js";
import type { TeamAutoScheduler } from "../teamauto/scheduler.js";

/**
 * Structural slice of ControllerHttpDeps (http-server.ts) covering exactly
 * the fields the switch machine reads. http-server and controller-service
 * keep passing their full ControllerHttpDeps object; TypeScript structural
 * typing accepts it, so no call site changes beyond the import path.
 */
export type TeamProfileSwitchDeps = {
  config: PluginConfig;
  logger: PluginLogger;
  getTeamState: () => TeamState | null;
  updateTeamState: UpdateTeamStateFn;
  wsServer: TeamWebSocketServer;
  workerProvisioningManager?: WorkerProvisioningManager | null;
  previewManager?: PreviewManager;
  /** Late-bound TeamAuto scheduler (autonomous repo collaboration). */
  getTeamAutoScheduler?: () => TeamAutoScheduler | null;
};

// ===========================================================================
// Team profile switch (Phase 2.1, vertical-team-profiles-design.md 2.3).
//
// Six-step semantics of POST /api/v1/team/profile:
//   0. validate profileId + reject concurrent switches (409)   [endpoint]
//   1. transition = { draining, target, startedAt }; persisted + WS event
//   2. graceful drain of in-flight tasks (timeout -> force-collect),
//      terminate workers                                        [drainTeam...]
//   3. archive the WHOLE TeamState + roles snapshot             [state.ts]
//   4. fresh capability-conditioned TeamState for the target
//   5. warm the target profile's warmupRoles                    [provisioner]
//   6. clear transition, persist, broadcast team.switch_completed
// ===========================================================================

const SWITCH_DRAIN_POLL_INTERVAL_MS = 500;

function sleepForSwitchDrain(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskInFlightForDrain(task: TaskInfo): boolean {
  return Boolean(task.assignedWorkerId) && (task.status === "assigned" || task.status === "in_progress");
}

/**
 * Design 2.3 step 2: graceful drain. Waits until no task is assigned /
 * in-progress any more (in-flight workers report results through their
 * normal endpoints, which stay open during the transition), then returns.
 * On timeout the remaining in-flight tasks are force-collected (failed with
 * an explicit error so the archive records the forced end) and all workers
 * are marked offline. Managed workers are terminated by the caller through
 * the provisioning manager's onWorkerRemoved (the terminateManagedWorker
 * single point); external workers observe 409 heartbeats and back off.
 */
async function drainTeamForProfileSwitch(
  deps: TeamProfileSwitchDeps,
): Promise<{ timedOut: boolean; forceCollected: string[] }> {
  const { config, logger, getTeamState, updateTeamState } = deps;
  const deadline = Date.now() + config.teamSwitchDrainTimeoutMs;
  while (Date.now() < deadline) {
    const state = getTeamState();
    if (!state || !Object.values(state.tasks).some(taskInFlightForDrain)) {
      return { timedOut: false, forceCollected: [] };
    }
    await sleepForSwitchDrain(SWITCH_DRAIN_POLL_INTERVAL_MS);
  }

  const forceCollected: string[] = [];
  updateTeamState((state) => {
    for (const task of Object.values(state.tasks)) {
      if (taskInFlightForDrain(task)) {
        task.status = "failed";
        task.error = `team profile switch drain timeout (${config.teamSwitchDrainTimeoutMs}ms) - in-flight task force-collected into the team archive`;
        task.updatedAt = Date.now();
        forceCollected.push(task.id);
      }
    }
    for (const worker of Object.values(state.workers)) {
      worker.status = "offline";
      worker.currentTaskId = undefined;
    }
  });
  logger.warn(
    `Controller: profile switch drain timed out after ${config.teamSwitchDrainTimeoutMs}ms - force-collected ${forceCollected.length} in-flight task(s)`,
  );
  return { timedOut: true, forceCollected };
}

export type TeamProfileSwitchOptions = {
  /**
   * Crash resume (design 2.3): the archive file for this switch already
   * exists, so skip the drain+archive steps (2-3) and rebuild the new team
   * directly (steps 4-6).
   */
  skipArchive?: boolean;
};

/**
 * Run switch steps 2-6 (step 1 - setting and persisting the transition -
 * belongs to the POST endpoint / crash resume). Exported so the controller
 * startup chain can resume an interrupted switch with the same semantics.
 */
export async function executeTeamProfileSwitch(
  deps: TeamProfileSwitchDeps,
  targetProfileId: string,
  options: TeamProfileSwitchOptions = {},
): Promise<void> {
  const { config, logger, getTeamState, updateTeamState, workerProvisioningManager } = deps;
  const target = BUILTIN_PROFILES.get(targetProfileId);
  if (!target) {
    throw new Error(`TeamClaw team profile "${targetProfileId}" is not available in this installation`);
  }
  // W4 (#226): phase flips persist through the single write entry. The
  // awaited-durability variant is used everywhere so callers that need the
  // crash-window barrier (step 3's archiving flip, step 5's warming flip)
  // can await it; callers that historically fire-and-forget the save simply
  // drop the handle (an un-awaited rejection behaves exactly like the old
  // floating void save).
  const setPhase = (phase: "draining" | "archiving" | "warming", options: TeamStateUpdateOptions = {}): TeamStateUpdateHandle => {
    return updateTeamState((state) => {
      if (state.transition?.targetProfileId === targetProfileId) {
        state.transition.phase = phase;
      }
    }, { ...options, persist: "awaited" });
  };

  if (!options.skipArchive) {
    // Step 2: drain in-flight work, then stop every worker.
    void setPhase("draining").persisted.catch(() => undefined);
    workerProvisioningManager?.setReconcileSuspended(true);
    const drain = await drainTeamForProfileSwitch(deps);
    for (const workerId of Object.keys(getTeamState()?.provisioning?.workers ?? {})) {
      if (workerProvisioningManager?.hasManagedWorker(workerId)) {
        await workerProvisioningManager
          .onWorkerRemoved(workerId, `team profile switch to "${targetProfileId}"`)
          .catch((err) => logger.warn(`Controller: failed to terminate managed worker ${workerId} during profile switch: ${String(err)}`));
      }
    }
    // Capability teardown for subsystems the target profile switches off
    // (minimal Phase 2.3 preview; the full 404 short-circuit lands in 2.3).
    // NOTE: teardown is one-directional at runtime. Switching a capability
    // back ON does not (re)start its subsystem here - TeamAuto scheduling
    // and preview restoration are wired at controller startup only, so an
    // off -> on switch (e.g. minimal-bank -> software-rd) takes effect for
    // those subsystems after the next gateway restart.
    if (!target.capabilities.teamauto) {
      const scheduler = deps.getTeamAutoScheduler?.() ?? null;
      if (scheduler) {
        try {
          await scheduler.stop();
        } catch { /* scheduler already stopped */ }
      }
    }
    if (!target.capabilities.runnablePreview && deps.previewManager) {
      try {
        await deps.previewManager.stopAll();
      } catch { /* previews already stopped */ }
    }

    // Step 3: archive the whole previous TeamState with a roles snapshot.
    // The phase flip is persisted BEFORE the archive write so a crash between
    // the two leaves an unambiguous "archive may exist" state for the resume
    // path (file existence check). W4 (#226): the awaited durability barrier
    // is the single entry's persisted handle (one save enqueued at the same
    // point the old fire-and-forget + awaited second save pair wrote).
    const archiving = setPhase("archiving");
    // #251 note (no behavior change): `sourceState` below is whatever
    // getTeamState() returns AFTER the awaited "archiving" persist barrier
    // - it is NOT a phase-accurate snapshot frozen at the moment the drain
    // finished. In-flight mutations racing the switch can be captured in
    // the archive; the resume path tolerates this because the transition
    // marker, not the snapshot contents, drives recovery.
    const sourceState = getTeamState();
    if (sourceState) {
      await archiving.persisted;
      const sourceProfile = getActiveProfile();
      await archiveTeamState(sourceState, {
        id: sourceProfile.id,
        name: sourceProfile.name,
        nameZh: sourceProfile.nameZh,
        version: sourceProfile.version,
        roles: sourceProfile.roles,
      });
      logger.info(
        `Controller: archived team "${sourceState.teamName}" (profile ${sourceProfile.id}, `
          + `${Object.keys(sourceState.tasks).length} task(s))${drain.timedOut ? " after drain timeout" : ""}`,
      );
    }
  }

  // Step 4: fresh TeamState for the target profile, conditioned on its
  // capability switches (design 2.3: banking omits repo/previews/reports).
  // setActiveProfileId and the state mutation below are both synchronous, so
  // no request can observe the new state against the old profile.
  const repoState = target.capabilities.git
    ? await ensureControllerGitRepo(config, logger).catch((err) => {
        logger.warn(`Controller: failed to prepare git collaboration repo for profile "${target.id}": ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : null;
  setActiveProfileId(target.id);
  const newCreatedAt = Date.now();
  const step4 = updateTeamState((state) => {
    state.profileId = target.id;
    state.teamName = target.name;
    state.workers = {};
    state.tasks = {};
    state.controllerRuns = {};
    state.projects = {};
    state.messages = [];
    state.clarifications = {};
    state.provisioning = { workers: {} };
    if (target.capabilities.git && repoState) {
      state.repo = repoState;
    } else {
      delete state.repo;
    }
    if (target.capabilities.runnablePreview) {
      state.previews = {};
    } else {
      delete state.previews;
    }
    if (target.capabilities.deliveryReview) {
      state.reports = {};
    } else {
      delete state.reports;
    }
    state.createdAt = newCreatedAt;
  }, { persist: "awaited" });
  await step4.persisted;

  // Step 5: warm the new profile's warmupRoles through the provisioning
  // pipeline (launch dispatch; registration/readiness tracking continues in
  // the background exactly like a cold start).
  await setPhase("warming").persisted;
  workerProvisioningManager?.setReconcileSuspended(false);
  if (workerProvisioningManager?.isEnabled() && target.warmupRoles.length > 0) {
    await workerProvisioningManager
      .warmRolesForTeamSwitch(target.warmupRoles, `profile switch warmup (${target.id})`)
      .catch((err) => logger.warn(`Controller: profile switch warmup failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  // Step 6: settle - clear the transition, persist, announce. W4 (#226):
  // the switch_completed broadcast rides the single entry's awaited
  // persistence, preserving the event order (persisted, then announced).
  const settled = updateTeamState((state) => {
    delete state.transition;
  }, {
    persist: "awaited",
    broadcast: [{ type: "team.switch_completed", data: { profileId: target.id } }],
  });
  await settled.persisted;
  logger.info(`Controller: team profile switch to "${target.id}" completed`);
}

/**
 * Design 2.3 crash semantics: on controller startup, an unfinished persisted
 * transition is resumed idempotently. If the archive file for this switch
 * already exists AND the phase is at/after "archiving", jump straight to
 * building the new team (skipArchive); otherwise re-run the drain from
 * scratch (drain is idempotent - a completed drain simply finds no in-flight
 * tasks). Returns true when a transition was resumed.
 */
// No team.switch_failed broadcast on this path: startup resume runs before
// the HTTP/WS listeners exist, so there are no clients to receive it - a
// failed resume surfaces through the fatal startup path instead (#201 review
// note, recorded for external reviewers).
export async function resumeTeamProfileSwitch(deps: TeamProfileSwitchDeps): Promise<boolean> {
  const state = deps.getTeamState();
  const transition = state?.transition;
  if (!state || !transition) {
    return false;
  }
  if (!hasProfile(transition.targetProfileId)) {
    // Same red line as restoring an unknown profileId (design 2.2): a team
    // mid-switch to an unavailable profile must never silently land on a
    // different profile.
    throw new Error(
      `Controller: interrupted team profile switch references profile "${transition.targetProfileId}", which is not available in this installation. `,
    );
  }
  deps.logger.info(
    `Controller: resuming interrupted team profile switch to "${transition.targetProfileId}" (phase: ${transition.phase}, started at ${new Date(transition.startedAt).toISOString()})`,
  );
  // A persisted state whose profileId already equals the target means step 4
  // flipped the team identity onto the NEW team. Step 4 strictly follows the
  // completed archive write in the same execution (the archive file lands
  // atomically before step 4 runs), so that flip PROVES the archive exists.
  // This covers both phase "warming" and the ghost-archive window between
  // the step-4 flip reaching disk and the warming phase persisting - on disk
  // that window reads as (phase "archiving", profileId = target), where
  // looking up the SOURCE-named archive file with state.profileId would miss
  // it and a re-drain would seal the already-emptied NEW team as a ghost
  // archive entry. (Alternative considered: persisting a sourceProfileId on
  // the transition - rejected; this flip predicate is the identical proof
  // without transition-shape or migration churn, and it also degrades the
  // manually-corrupted (draining, target) combination the same safe way.)
  const step4Flipped = state.profileId === transition.targetProfileId;
  const archiveExists = step4Flipped
    || transition.phase === "warming"
    || Boolean(await findTeamSwitchArchive(state.profileId, transition.startedAt));
  const phaseAtOrAfterArchive = transition.phase === "archiving" || transition.phase === "warming";
  await executeTeamProfileSwitch(deps, transition.targetProfileId, {
    skipArchive: archiveExists && (phaseAtOrAfterArchive || step4Flipped),
  });
  return true;
}

/**
 * Fire-and-forget switch execution launched by POST /api/v1/team/profile
 * after step 1 (transition persisted + switch_started broadcast). Owns the
 * failure path: worst-case archive-preservation detection, the
 * team.switch_failed broadcast, and unwedging the transition.
 */
export function startTeamProfileSwitch(
  deps: TeamProfileSwitchDeps,
  state: TeamState,
  profileId: string,
  previousProfileId: string,
): void {
  const { logger, wsServer, updateTeamState } = deps;
  void executeTeamProfileSwitch(deps, profileId).catch(async (err) => {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error(`Controller: team profile switch to "${profileId}" failed: ${detail}`);
    // Never leave the team wedged in a transition: clear it so whichever
    // team the state now holds keeps serving and the switch can be
    // re-issued. The archive (if step 3 ran) keeps the previous team. Also
    // lift the provisioning reconcile suspension so the manager keeps
    // operating for whichever team survived.
    deps.workerProvisioningManager?.setReconcileSuspended(false);
    // Honest worst case for the failure payload: once the step-3 archive
    // write has landed (or step 4 already flipped the team identity - which
    // strictly proves the archive landed), the state on disk may be
    // partially switched and a restart is the reliable recovery. Detect
    // with the same resume-path predicate: a source-named archive file at
    // or after the transition's startedAt.
    const transition = state.transition;
    let archivePreserved = state.profileId === profileId;
    if (!archivePreserved && transition) {
      archivePreserved = Boolean(await findTeamSwitchArchive(previousProfileId, transition.startedAt).catch(() => null));
    }
    const reason = archivePreserved
      ? `${detail} (archive preserved, team state may be partially switched, restart recommended)`
      : detail;
    // Broadcast BEFORE clearing the transition: the web switcher releases
    // its loading/confirm state on this event instead of silently timing
    // out on the reconcile fallback.
    wsServer.broadcastUpdate({
      type: "team.switch_failed",
      data: { previousProfileId, targetProfileId: profileId, reason },
    });
    // W4 (#226): best-effort persist of the unwedging through the single
    // entry - one enqueued save with the failure path's swallow (the old
    // shape fired an un-caught floating save plus this caught one).
    const cleared = updateTeamState((s) => {
      if (s.transition?.targetProfileId === profileId) {
        delete s.transition;
      }
    }, { persist: "awaited" });
    void cleared.persisted.catch(() => undefined);
  });
}
