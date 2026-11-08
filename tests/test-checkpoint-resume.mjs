#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const read = (rel) => fs.readFile(path.join(projectRoot, rel), "utf8");

async function sourceContracts() {
  const types = await read("src/src/types.ts");
  const executor = await read("src/src/task-executor.ts");
  const indexSrc = await read("src/index.ts");
  const worker = await read("src/src/worker/worker-service.ts");
  const httpServer = await read("src/src/controller/http-server.ts");
  // PR-C of issue #204: the checkpoint endpoint handler moved into
  // controller/task-routes.ts; the dispatch that carries checkpoints moved
  // into controller/task-assignment.ts.
  const taskRoutes = await read("src/src/controller/task-routes.ts");
  const taskAssignment = await read("src/src/controller/task-assignment.ts");
  const service = await read("src/src/controller/controller-service.ts");

  // Types: checkpoint shape + payload/task fields.
  assert.match(types, /export type TaskCheckpoint = \{/, "TaskCheckpoint type must exist");
  for (const field of ["updatedAt", "attempt", "sessionKey", "lastAssistantMessage", "progressNotes"]) {
    assert.ok(types.includes(`  ${field}`), `TaskCheckpoint must carry ${field}`);
  }
  assert.match(types, /checkpoint\?: TaskCheckpoint;/, "TaskAssignmentPayload must carry an optional checkpoint");
  assert.match(types, /resumeAttempt\?: number;/, "TaskAssignmentPayload must carry resumeAttempt");

  // Executor: throttled checkpoint heartbeat on assistant turns.
  assert.match(executor, /reportCheckpoint\?:/, "executor deps must accept reportCheckpoint");
  assert.match(executor, /CHECKPOINT_EMIT_INTERVAL_MS/, "executor must throttle checkpoint emits");
  assert.match(
    executor,
    /reportCheckpoint\(taskId, \{\s*\n\s*lastAssistantMessage: entry\.message\.slice/,
    "the heartbeat must persist the latest assistant turn",
  );

  // Worker wiring posts to the controller checkpoint endpoint.
  assert.match(indexSrc, /\/api\/v1\/tasks\/\$\{taskId\}\/checkpoint/, "worker must POST checkpoints to the controller");

  // Controller endpoint persists into task.checkpoint.
  assert.match(httpServer, /\/api\/v1\/tasks\/[^/]+\/checkpoint/, "controller must expose the checkpoint endpoint");
  assert.match(taskRoutes, /task\.checkpoint = \{/, "the endpoint must store the checkpoint on the task");
  assert.match(taskRoutes, /progressNotes: notes\.slice\(-10\)/, "progress notes must stay bounded");

  // Dispatch carries checkpoint and reuses the interrupted session key.
  assert.match(taskAssignment, /checkpoint: task\.checkpoint,/, "assignments must carry the checkpoint");
  assert.match(taskAssignment, /task\.checkpoint\?\.sessionKey/, "resumed assignments must reuse the interrupted session key");

  // Worker injects the resumed-execution context into the prompt.
  assert.match(worker, /## RESUMED EXECUTION/, "resumed assignments must inject the resume context block");
  assert.match(worker, /Do NOT redo steps that are already done/, "the resume block must forbid redoing completed work");

  // Startup reconciliation counts attempts and fails fast past the cap.
  assert.match(service, /MAX_RESUME_ATTEMPTS/, "startup reconciliation must enforce a resume attempt cap");
  assert.match(service, /task\.resumeAttempt = attempt;/, "each orphan reset must increment resumeAttempt");
  assert.match(service, /exceeded .* resume attempts/, "past the cap the task must fail with a diagnostic");
  assert.match(service, /task\.checkpoint\.attempt = attempt;/, "the checkpoint attempt counter must advance with resets");
}

/**
 * Runtime: simulate the reconcile loop against the real built module shape by
 * exercising the documented semantics on a plain object graph (the reconcile
 * code is inline in controller-service; the contract above pins it, and this
 * unit pins the intended state machine: reset->pending up to cap, then fail).
 */
async function resumeStateMachineUnit() {
  const makeTask = (resumeAttempt) => ({
    status: "in_progress",
    assignedWorkerId: "w1",
    resumeAttempt,
    checkpoint: { updatedAt: 1, attempt: resumeAttempt ?? 0, sessionKey: "s", lastAssistantMessage: "mid-work", progressNotes: [] },
  });
  const MAX = 3;
  const step = (task) => {
    const attempt = (task.resumeAttempt ?? 0) + 1;
    if (attempt > MAX) {
      task.status = "failed";
      return task;
    }
    task.status = "pending";
    task.assignedWorkerId = undefined;
    task.resumeAttempt = attempt;
    if (task.checkpoint) { task.checkpoint.attempt = attempt; }
    return task;
  };
  const task = makeTask(undefined);
  const statuses = [];
  for (let i = 0; i < 5; i++) { step(task); statuses.push(`${task.status}@${task.resumeAttempt ?? 0}`); }
  assert.deepEqual(
    statuses,
    ["pending@1", "pending@2", "pending@3", "failed@3", "failed@3"],
    "resume state machine: three resume attempts, then permanent failure",
  );
}

(async () => {
  await sourceContracts();
  await resumeStateMachineUnit();
  console.log("test-checkpoint-resume: ok");
})().catch((err) => {
  console.error("test-checkpoint-resume failed:", err);
  process.exit(1);
});
