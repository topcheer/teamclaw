#!/usr/bin/env node
// Phase 1.7 (vertical-team-profiles-design.md 1.7): prompt golden generator.
//
// Renders the controller and worker system-prompt injectors against a fixed
// fake context and writes the exact output bytes to tests/golden/*.txt.
// The committed golden files were first generated on origin/main @ b076f25
// (pre Phase 1.3); tests/test-software-rd-golden.mjs asserts the current
// build reproduces them byte for byte, so the profile-loader refactor and
// any later change must be a deliberate golden regeneration.
//
// Regenerate deliberately (prompt wording change, profile swap):
//   npm --prefix src run build && node tests/golden/regen-prompt-golden.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..", "..");

// The controller injector scans <workspace>/projects on the filesystem.
// Pin the workspace to a fresh empty temp dir so the golden depends only on
// the injected fake state, never on the machine it runs on. resolveTeamClaw-
// WorkspaceDir reads TEAMCLAW_WORKSPACE_DIR at call time.
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "teamclaw-golden-"));

const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

const { parsePluginConfig } = await dist("types.js");
const { createControllerPromptInjector } = await dist("controller/prompt-injector.js");
const { createWorkerPromptInjector } = await dist("worker/prompt-injector.js");
const { MessageQueue } = await dist("worker/message-queue.js");

// ---------------------------------------------------------------------------
// Fixed fake context. Every value is a literal: no Date.now(), no random, no
// environment-dependent fallbacks. This is the input contract of the golden.
// ---------------------------------------------------------------------------

const CONTROLLER_CONFIG = parsePluginConfig({
  mode: "controller",
  teamName: "Golden Team",
  port: 9527,
  maxConcurrentTasks: 5,
});

const CONTROLLER_STATE = {
  version: 2,
  teamName: "Golden Team",
  createdAt: 1730000000000,
  updatedAt: 1730000100000,
  workers: {
    "worker-golden-1": {
      id: "worker-golden-1",
      role: "developer",
      label: "Developer (golden-1)",
      status: "busy",
      url: "http://127.0.0.1:9601",
      lastHeartbeat: 1730000090000,
      capabilities: ["coding"],
      currentTaskId: "task-golden-2",
      registeredAt: 1730000001000,
    },
    "worker-golden-2": {
      id: "worker-golden-2",
      role: "qa",
      label: "QA Engineer (golden-2)",
      status: "idle",
      url: "http://127.0.0.1:9602",
      lastHeartbeat: 1730000095000,
      capabilities: ["test-planning"],
      registeredAt: 1730000002000,
    },
  },
  tasks: {
    "task-golden-1": {
      id: "task-golden-1",
      title: "Golden pending task: write login user stories",
      description: "Turn the golden requirement into user stories.",
      status: "pending",
      priority: "high",
      assignedRole: "pm",
      createdBy: "human",
      createdAt: 1730000010000,
      updatedAt: 1730000010000,
    },
    "task-golden-2": {
      id: "task-golden-2",
      title: "Golden active task: implement login endpoint",
      description: "Implement the login endpoint per the golden spec.",
      status: "in_progress",
      priority: "high",
      assignedRole: "developer",
      assignedWorkerId: "worker-golden-1",
      createdBy: "human",
      createdAt: 1730000020000,
      updatedAt: 1730000030000,
    },
    "task-golden-3": {
      id: "task-golden-3",
      title: "Golden blocked task: verify login flow",
      description: "Blocked waiting for the golden credentials.",
      status: "blocked",
      priority: "medium",
      assignedRole: "qa",
      createdBy: "human",
      createdAt: 1730000040000,
      updatedAt: 1730000050000,
    },
    "task-golden-4": {
      id: "task-golden-4",
      title: "Golden completed task: design login schema",
      description: "Database schema for the golden login service.",
      status: "completed",
      priority: "medium",
      assignedRole: "architect",
      createdBy: "human",
      projectDir: "projects/golden-login",
      createdAt: 1730000060000,
      updatedAt: 1730000070000,
    },
  },
  controllerRuns: {},
  projects: {
    "project-golden-1": {
      id: "project-golden-1",
      projectDir: "projects/golden-blog",
      aliases: ["golden-blog", "gb"],
      summary: "Golden blog project seeded in state",
      createdAt: 1730000005000,
      updatedAt: 1730000005000,
      lastUsedAt: 1730000005000,
    },
  },
  messages: [],
  clarifications: {
    "clarification-golden-1": {
      id: "clarification-golden-1",
      taskId: "task-golden-3",
      requestedBy: "worker-golden-2",
      question: "Which golden environment should the login flow run against?",
      blockingReason: "missing golden environment",
      status: "pending",
      createdAt: 1730000045000,
      updatedAt: 1730000045000,
    },
  },
};

const controllerInjector = createControllerPromptInjector({
  config: CONTROLLER_CONFIG,
  getTeamState: () => CONTROLLER_STATE,
});
const controllerPrompt = controllerInjector()?.prependSystemContext ?? "";
assert.ok(controllerPrompt.length > 0, "controller injector golden output must not be empty");

// ---------------------------------------------------------------------------

const WORKER_CONFIG = parsePluginConfig({
  mode: "worker",
  role: "qa",
  teamName: "Golden Team",
  controllerUrl: "http://127.0.0.1:9527",
});

const WORKER_IDENTITY = {
  workerId: "worker-golden-2",
  role: "qa",
  controllerUrl: "http://127.0.0.1:9527",
  registeredAt: 1730000002000,
};

const workerMessageQueue = new MessageQueue();
workerMessageQueue.push({
  id: "message-golden-1",
  from: "worker-golden-1",
  fromRole: "developer",
  to: "worker-golden-2",
  toRole: "qa",
  type: "direct",
  content: "Golden login endpoint is ready for review.",
  taskId: "task-golden-2",
  createdAt: 1730000080000,
});
workerMessageQueue.push({
  id: "message-golden-2",
  from: "controller",
  type: "broadcast",
  content: "Golden broadcast: requirement review at the next checkpoint.",
  createdAt: 1730000085000,
});

const workerInjector = createWorkerPromptInjector(
  WORKER_CONFIG,
  () => WORKER_IDENTITY,
  workerMessageQueue,
);
const workerPrompt = workerInjector()?.prependSystemContext ?? "";
assert.ok(workerPrompt.length > 0, "worker injector golden output must not be empty");

// ---------------------------------------------------------------------------

const goldenFiles = [
  ["controller-prompt.txt", controllerPrompt],
  ["worker-prompt.txt", workerPrompt],
];
for (const [name, contents] of goldenFiles) {
  const target = path.join(scriptDir, name);
  fs.writeFileSync(target, contents, "utf8");
  console.log(`Wrote ${path.relative(projectRoot, target)} (${Buffer.byteLength(contents, "utf8")} bytes)`);
}
