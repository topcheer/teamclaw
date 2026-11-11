// Hot-reloadable worker-provisioning configuration routes (runtime scaling).
//
// GET  /api/v1/team/config  -> read-only snapshot of the hot-reloadable fields
// PATCH /api/v1/team/config -> whitelist-only update that
//   1. mutates deps.config IN MEMORY (the provisioner reads these fields on
//      every computeRoleDemand pass, so the change applies on the next
//      reconcile tick — no restart),
//   2. persists to the host openclaw.json plugins.entries.teamclaw.config
//      (same read-modify-write pattern as updateTeamClawModelConfig), and
//   3. pokes the provisioner via requestReconcile + broadcasts a
//      team:config_updated WS event so desktop/web UIs refresh.
//
// Deployment-shape behavior (issue context: all deployment forms):
// - process / managed-gateway / desktop-private / tunnel: memory + host-config
//   persistence (resolveDefaultOpenClawConfigPath honors OPENCLAW_HOME /
//   OPENCLAW_CONFIG_PATH, so sandboxed instances persist into their own home).
// - docker (controller on host): same as process — host config is writable.
// - docker/k8s (controller itself containerized): container FS is ephemeral,
//   so persistence degrades to memory-only and the response carries
//   persistenceMode: "memory-only" + a restart note (declared behavior, not
//   a silent drop). k8s deployments should source config from ConfigMap and
//   treat this API as runtime-only scaling.
// Scale-down semantics: lowering maxPerRole never kills active workers; idle
// workers drain via workerProvisioningIdleTtlMs and the cap stops refills.
import { parseJsonBody, sendJson, sendError } from "../protocol.js";
import { updateTeamClawProvisioningConfig } from "../openclaw-workspace.js";
import type { RouteContext } from "./route-table.js";

/** Fields a PATCH may touch. Everything else in PluginConfig is rejected. */
const HOT_CONFIG_FIELDS = [
  "workerProvisioningMaxPerRole",
  "workerProvisioningMinPerRole",
  "workerProvisioningIdleTtlMs",
] as const;
type HotConfigField = (typeof HOT_CONFIG_FIELDS)[number];

const BOUNDS: Record<HotConfigField, { min: number; max: number }> = {
  workerProvisioningMaxPerRole: { min: 1, max: 50 },
  workerProvisioningMinPerRole: { min: 0, max: 50 },
  // 1s floor keeps the idle reaper from churn-looping; 24h ceiling is generous.
  workerProvisioningIdleTtlMs: { min: 1_000, max: 86_400_000 },
};

function teamConfigGetRoute(ctx: RouteContext): void {
  const { res, deps } = ctx;
  const c = deps.config;
  sendJson(res, 200, {
    workerProvisioningType: c.workerProvisioningType,
    workerProvisioningDisabled: c.workerProvisioningDisabled,
    workerProvisioningMinPerRole: c.workerProvisioningMinPerRole,
    workerProvisioningMaxPerRole: c.workerProvisioningMaxPerRole,
    workerProvisioningIdleTtlMs: c.workerProvisioningIdleTtlMs,
    // k8s controllers run on ephemeral container FS: declare it up front.
    persistenceMode: c.workerProvisioningType === "kubernetes" ? "memory-only" : "host-config",
  });
}

async function teamConfigPatchRoute(ctx: RouteContext): Promise<void> {
  const { req, res, deps } = ctx;
  let body: Record<string, unknown> | null = null;
  try {
    body = (await parseJsonBody(req)) as Record<string, unknown>;
  } catch {
    sendError(res, 400, "invalid JSON body");
    return;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    sendError(res, 400, "JSON object body required");
    return;
  }

  const unknown = Object.keys(body).filter((k) => !(HOT_CONFIG_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    sendError(res, 400, `unknown or non-hot-reloadable field(s): ${unknown.join(", ")}`);
    return;
  }

  const update: Partial<Record<HotConfigField, number>> = {};
  for (const field of HOT_CONFIG_FIELDS) {
    if (body[field] === undefined) continue;
    const raw = body[field];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      sendError(res, 400, `${field} must be a finite number`);
      return;
    }
    const { min, max } = BOUNDS[field];
    update[field] = Math.max(min, Math.min(max, Math.floor(raw)));
  }
  if (Object.keys(update).length === 0) {
    sendError(res, 400, `at least one of ${HOT_CONFIG_FIELDS.join(", ")} is required`);
    return;
  }

  // 1) In-memory hot apply (deps.config is a live reference the provisioner
  //    reads on every demand computation — no restart needed).
  const applied: Record<string, number> = {};
  for (const [field, value] of Object.entries(update) as [HotConfigField, number][]) {
    (deps.config as unknown as Record<string, number>)[field] = value;
    applied[field] = value;
  }
  // Keep the min<=max invariant types.ts enforces at parse time.
  const minR = update.workerProvisioningMinPerRole ?? deps.config.workerProvisioningMinPerRole;
  if (deps.config.workerProvisioningMaxPerRole < minR) {
    deps.config.workerProvisioningMaxPerRole = minR;
    applied.workerProvisioningMaxPerRole = minR;
  }

  // 2) Persist (host config) unless the controller itself runs on an
  //    ephemeral container FS.
  const memoryOnly = deps.config.workerProvisioningType === "kubernetes";
  let persisted = false;
  if (!memoryOnly) {
    try {
      await updateTeamClawProvisioningConfig(applied, {
        warn: (message: string) => deps.logger.info(message),
      });
      persisted = true;
    } catch (err) {
      // Memory already applied — report partial success honestly.
      deps.logger.warn(
        `TeamClaw: hot config applied in memory but host-config persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3) Poke the provisioner so the new caps apply immediately instead of
  //    waiting for the next periodic reconcile tick, then tell UIs.
  try {
    await deps.workerProvisioningManager?.requestReconcile("team-config-hot-update");
  } catch (err) {
    deps.logger.warn(
      `TeamClaw: config hot-update reconcile poke failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  deps.wsServer.broadcastUpdate({ type: "team:config_updated", data: { ...applied, persisted } });
  deps.logger.info(`TeamClaw: worker provisioning config hot-updated: ${JSON.stringify(applied)} (persisted=${persisted})`);

  sendJson(res, 200, {
    ok: true,
    applied,
    persisted,
    persistenceMode: persisted ? "host-config" : "memory-only",
    ...(persisted
      ? {}
      : {
          restartNote:
            "Applied in memory only; this deployment shape does not persist to a durable host config — after a gateway restart the config reverts to its persisted source.",
        }),
  });
}

export { teamConfigGetRoute, teamConfigPatchRoute };
