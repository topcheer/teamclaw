#!/usr/bin/env node
/**
 * Regression tests — each assertion guards against re-introducing a bug
 * that was fixed in a specific commit.
 *
 * Traceability:
 *
 *   ba4173d  fix: prevent task-routing spin loop in single-process mode
 *   52c0c9c  fix: startup reconciliation for orphaned pending tasks
 *   97a8ff9  fix: restore openclaw host compatibility
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const httpServerPath = path.join(projectRoot, "src", "src", "controller", "http-server.ts");

await runRegressionSmoke();

// -----------------------------------------------------------------------

async function runRegressionSmoke() {
  const httpServerSource = await fs.readFile(httpServerPath, "utf8");

  // --- ba4173d: prevent task-routing spin loop in single-process mode ---
  //
  // The fix replaced a tight `continue` loop (which could spin at 100% CPU
  // when provisioning in-process workers) with a debounced
  // `scheduleProvisioningReconcile` call.  The regression guard ensures
  // autoAssignPendingTasks does NOT contain an unconditional `continue`
  // inside the provisioning branch, and instead breaks out or delegates
  // to a scheduled reconcile.

  assert.doesNotMatch(
    httpServerSource,
    /provisioned > 0[\s\S]*?continue;[\s\S]*?\/\/ re-check assignments/,
    "autoAssignPendingTasks should not tight-loop on provisioned workers (ba4173d)",
  );

  assert.match(
    httpServerSource,
    /scheduleProvisioningReconcile/,
    "autoAssignPendingTasks should delegate provisioning retries to scheduleProvisioningReconcile instead of looping (ba4173d)",
  );

  // --- 52c0c9c: startup reconciliation for orphaned pending tasks ---
  //
  // After a restart, persisted tasks may be pending with no worker.
  // The fix adds a delayed auto-assign that fires after the server is up.
  // The regression guard ensures the startup reconciliation block exists
  // and counts only tasks that have no assigned worker.

  assert.match(
    httpServerSource,
    /startup reconciliation[\s\S]*?pending tasks.*?triggering auto-assign/,
    "controller server should log startup reconciliation for pending tasks after a restart (52c0c9c)",
  );

  assert.match(
    httpServerSource,
    /status === "pending" && !t\.assignedWorkerId/,
    "startup reconciliation should only count unassigned pending tasks, not tasks already claimed by a worker (52c0c9c)",
  );

  assert.match(
    httpServerSource,
    /void autoAssignPendingTasks\(deps\)\.catch\(/,
    "startup reconciliation should fire-and-forget autoAssignPendingTasks with error handling (52c0c9c)",
  );

  // --- 97a8ff9: restore openclaw host compatibility ---
  //
  // Operator-precedence bug: `a ?? b || undefined` evaluates as
  // `(a ?? b) || undefined`, which can discard a valid explicit project ID
  // when it is the only value.  The fix wraps the fallback in parentheses:
  // `a ?? (b || undefined)`.
  //
  // We verify both instances where explicit project names are resolved
  // use the parenthesised form.

  assert.match(
    httpServerSource,
    /inheritedProject\?\.projectId \?\? \(explicitProjectId \|\| undefined\)/,
    "controller task creation should parenthesise the project-ID fallback to avoid precedence bug (97a8ff9)",
  );

  assert.match(
    httpServerSource,
    /inheritedProject\?\.projectId \?\? \(explicitProjectName \|\| undefined\)/,
    "controller intake task creation should parenthesise the project-name fallback to avoid precedence bug (97a8ff9)",
  );

  console.log("Regression smoke passed.");
}
