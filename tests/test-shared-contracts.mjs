#!/usr/bin/env node
/**
 * Test: shared contracts layer direction gates (issue #226, W3 + W5)
 *
 * Locks the dependency direction restored by the shared-contract extraction:
 *
 *  1. worker/ must never import the controller tree — neither statically
 *     (`from "../controller/...`) nor dynamically (`import("../controller/...)`).
 *     Before W3, worker/tools.ts static-imported orchestration-manifest.js and
 *     worker/worker-service.ts dynamically imported kickoff-orchestrator.js,
 *     so worker-mode deployments dragged in the whole controller code tree.
 *  2. teamauto/ must never import the controller tree. Before W5 its three
 *     modules imported the GithubAuthManager type from controller/github-auth.ts.
 *  3. shared/ itself must never import back into controller/ (that would just
 *     re-create the cycle one layer down).
 *  4. Positive anchors pin each extracted contract to its shared home and pin
 *     the consumers that now point at shared (worker, teamauto, controller).
 *  5. Runtime spot-checks against the built dist confirm the extracted
 *     clarification normalizers and kickoff prompt behave identically
 *     (verbatim lifts; see also test-controller-manifest.mjs and
 *     test-kickoff-meeting.mjs for their deeper behavior anchors).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const srcRoot = path.join(projectRoot, "src", "src");

function readSource(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function listTypeScriptFiles(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".ts"));
}

/** Matches static `from "../controller/..."` and dynamic `import("../controller/...")` specifiers. */
const controllerImportPattern = /(?:from\s*["']|import\(\s*["'])\.\.\/(?:\.\.\/)?controller\//;

// ── 1 + 2 + 3. Direction gates: worker/, teamauto/, shared/ ────────────────

for (const [dirLabel, dirPath] of [
  ["worker", path.join(srcRoot, "worker")],
  ["teamauto", path.join(srcRoot, "teamauto")],
  ["shared", path.join(srcRoot, "shared")],
]) {
  for (const file of listTypeScriptFiles(dirPath)) {
    const source = fs.readFileSync(path.join(dirPath, file), "utf8");
    assert.doesNotMatch(
      source,
      controllerImportPattern,
      `${dirLabel}/${file}: must not import the controller tree (issue #226 W3/W5 — depend on src/src/shared/ instead)`,
    );
  }
}

console.log("✅ Direction gates passed: worker/, teamauto/, shared/ import zero controller modules");

// ── 4a. Clarification-schema contract (W3) ─────────────────────────────────

const clarificationSchemaSource = readSource("src/src/shared/clarification-schema.ts");
for (const name of [
  "normalizeOptionalManifestText",
  "normalizeClarificationOptions",
  "normalizeClarificationQuestionSchema",
  "normalizeClarificationQuestionSchemas",
]) {
  assert.match(
    clarificationSchemaSource,
    new RegExp(`export function ${name}\\b`),
    `shared/clarification-schema.ts must export ${name}`,
  );
}

const orchestrationManifestSource = readSource("src/src/controller/orchestration-manifest.ts");
assert.match(
  orchestrationManifestSource,
  /from "\.\.\/shared\/clarification-schema\.js"/,
  "orchestration-manifest.ts must import the clarification-schema contract from the shared layer",
);
assert.doesNotMatch(
  orchestrationManifestSource,
  /export function normalizeClarificationQuestionSchema\b/,
  "orchestration-manifest.ts must not re-export the moved clarification normalizers (single home in shared/)",
);

const workerToolsSource = readSource("src/src/worker/tools.ts");
assert.match(
  workerToolsSource,
  /import \{ normalizeClarificationQuestionSchema \} from "\.\.\/shared\/clarification-schema\.js"/,
  "worker/tools.ts must import normalizeClarificationQuestionSchema from the shared layer",
);

console.log("✅ Clarification-schema contract anchors passed");

// ── 4b. Kickoff prompt contract (W3) ───────────────────────────────────────

const kickoffPromptSource = readSource("src/src/shared/kickoff-prompt.ts");
assert.match(
  kickoffPromptSource,
  /export function buildKickoffAssessmentPrompt\b/,
  "shared/kickoff-prompt.ts must export buildKickoffAssessmentPrompt",
);

const kickoffOrchestratorSource = readSource("src/src/controller/kickoff-orchestrator.ts");
assert.doesNotMatch(
  kickoffOrchestratorSource,
  /buildKickoffAssessmentPrompt/,
  "kickoff-orchestrator.ts must no longer define the kickoff assessment prompt (moved to shared/kickoff-prompt.ts)",
);

const workerServiceSource = readSource("src/src/worker/worker-service.ts");
assert.match(
  workerServiceSource,
  /import\("\.\.\/shared\/kickoff-prompt\.js"\)/,
  "worker/worker-service.ts must dynamically import the kickoff prompt from the shared layer",
);

const controllerServiceSource = readSource("src/src/controller/controller-service.ts");
assert.match(
  controllerServiceSource,
  /import \{ buildKickoffAssessmentPrompt \} from "\.\.\/shared\/kickoff-prompt\.js"/,
  "controller-service.ts must import buildKickoffAssessmentPrompt from the shared layer",
);

console.log("✅ Kickoff prompt contract anchors passed");

// ── 4c. GithubAuthManager type contract (W5) ───────────────────────────────

const sharedGithubAuthSource = readSource("src/src/shared/github-auth.ts");
assert.match(
  sharedGithubAuthSource,
  /export type GithubAuthManager = \{/,
  "shared/github-auth.ts must declare the GithubAuthManager contract as an explicit structural type",
);
assert.doesNotMatch(
  sharedGithubAuthSource,
  /export type GithubAuthManager = ReturnType/,
  "shared/github-auth.ts must not derive GithubAuthManager via ReturnType of the controller factory (that would drag controller code into the shared layer)",
);
for (const member of [
  "beginLogin",
  "beginDeviceLogin",
  "completeLogin",
  "getAccessToken",
  "getAuthHeaders",
  "getStatus",
  "forceRefresh",
  "logout",
]) {
  assert.match(
    sharedGithubAuthSource,
    new RegExp(`${member}:`),
    `GithubAuthManager contract must keep the ${member} member`,
  );
}

for (const teamautoFile of ["github-client.ts", "scheduler.ts", "repo-sync.ts"]) {
  const source = readSource(path.join("src/src/teamauto", teamautoFile));
  assert.match(
    source,
    /import type \{ GithubAuthManager \} from "\.\.\/shared\/github-auth\.js"/,
    `teamauto/${teamautoFile} must import GithubAuthManager from the shared layer`,
  );
}

const controllerGithubAuthSource = readSource("src/src/controller/github-auth.ts");
assert.match(
  controllerGithubAuthSource,
  /\} = \{\}\): GithubAuthManager \{/,
  "createGithubAuthManager must be annotated with the shared GithubAuthManager return type (compiler-enforced structural equivalence — the drift guard that replaced ReturnType inference)",
);
assert.match(
  controllerGithubAuthSource,
  /from "\.\.\/shared\/github-auth\.js"/,
  "controller/github-auth.ts must consume the shared GithubAuthManager contract",
);
assert.match(
  controllerGithubAuthSource,
  /export function createGithubAuthManager/,
  "the auth manager factory stays in controller/github-auth.ts (only the type contract moved)",
);
assert.match(
  controllerGithubAuthSource,
  /export function getGithubAuthManager/,
  "the cached manager accessor stays in controller/github-auth.ts",
);

console.log("✅ GithubAuthManager contract anchors passed");

// ── 5. Runtime spot-checks against the built dist ──────────────────────────

const distSharedDir = path.join(projectRoot, "src", "dist", "src", "shared");
for (const built of ["clarification-schema.js", "kickoff-prompt.js", "github-auth.js"]) {
  assert.ok(
    fs.existsSync(path.join(distSharedDir, built)),
    `dist/src/shared/${built} must exist after the build (run npm --prefix src run build first)`,
  );
}

// Built worker artifacts must not reference controller module specifiers either.
for (const builtWorker of ["tools.js", "worker-service.js"]) {
  const compiled = fs.readFileSync(path.join(projectRoot, "src", "dist", "src", "worker", builtWorker), "utf8");
  assert.ok(
    !compiled.includes('"../controller/'),
    `dist/src/worker/${builtWorker}: compiled worker artifact must not import controller modules`,
  );
}

const clarificationModule = await import(pathToFileURL(path.join(distSharedDir, "clarification-schema.js")).href);
const validSchema = clarificationModule.normalizeClarificationQuestionSchema({
  kind: "single-select",
  title: " Which tenant tiers? ",
  description: "  ",
  options: [
    { value: "free", label: " Free ", hint: "" },
    { value: "", label: "dropped" },
  ],
  required: 0,
  extra: "ignored",
});
assert.deepEqual(
  validSchema,
  {
    kind: "single-select",
    title: "Which tenant tiers?",
    description: undefined,
    required: false,
    allowOther: false,
    placeholder: undefined,
    unit: undefined,
    options: [{ value: "free", label: "Free", hint: undefined }],
  },
  "normalizeClarificationQuestionSchema behavior must be unchanged after the lift to shared/",
);
assert.equal(
  clarificationModule.normalizeClarificationQuestionSchema({ kind: "single-select", title: "No options" }),
  undefined,
  "select questions without options must still be rejected",
);
assert.equal(
  clarificationModule.normalizeClarificationQuestionSchema({ kind: "radio", title: "Bad kind" }),
  undefined,
  "unknown question kinds must still be rejected",
);
assert.deepEqual(
  clarificationModule.normalizeClarificationQuestionSchemas("not-an-array"),
  [],
  "normalizeClarificationQuestionSchemas must still coerce non-array payloads to []",
);

const kickoffPromptModule = await import(pathToFileURL(path.join(distSharedDir, "kickoff-prompt.js")).href);
const assessmentPrompt = kickoffPromptModule.buildKickoffAssessmentPrompt("developer", "Add SSO to the web app");
for (const fragment of [
  "in a virtual software team",
  "kickoff meeting",
  "## Requirement",
  "Add SSO to the web app",
  '"needed": boolean',
  '"suggestedTasks"',
  "Return ONLY the JSON object",
]) {
  assert.ok(
    assessmentPrompt.includes(fragment),
    `buildKickoffAssessmentPrompt output must keep the "${fragment}" contract fragment`,
  );
}

console.log("✅ Runtime spot-checks passed (clarification normalizers + kickoff prompt)");

// ── 6. Dependency-direction summary (informational) ────────────────────────

console.log(`
Dependency direction after issue #226 W3+W5:

  worker/    -> shared/  (clarification-schema, kickoff-prompt)   [was: controller/]
  teamauto/  -> shared/  (github-auth type)                       [was: controller/]
  controller -> shared/  (all three contracts)
  shared/    -> types.js, profile-loader.js (root-level only; never controller/)
`);

console.log("🎉 test-shared-contracts: all direction gates and contract anchors passed");
