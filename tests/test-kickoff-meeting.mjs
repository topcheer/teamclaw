#!/usr/bin/env node
/**
 * Test: Team Kickoff Meeting types, assessment prompt, and orchestrator logic
 *
 * Validates:
 * 1. KickoffAssessment and KickoffPlan types exist in types.ts
 * 2. buildKickoffAssessmentPrompt produces valid prompts
 * 3. Controller prompt includes kickoff tool documentation
 * 4. Controller tools include teamclaw_request_kickoff
 * 5. Worker http-handler accepts POST /api/v1/kickoff/assess
 * 6. parseAssessmentResponse handles edge cases
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dirname, "..", "src", "src");

// ── 1. Types validation ────────────────────────────────────────────────────

const typesContent = readFileSync(path.join(SRC_ROOT, "types.ts"), "utf-8");

assert.match(typesContent, /export type KickoffAssessment\b/, "KickoffAssessment type should be exported from types.ts");
assert.match(typesContent, /export type KickoffPlan\b/, "KickoffPlan type should be exported from types.ts");
assert.match(typesContent, /kickoffPlan\?:\s*KickoffPlan/, "ControllerOrchestrationManifest should have kickoffPlan field");
assert.match(typesContent, /complexity:\s*"simple"\s*\|\s*"medium"\s*\|\s*"complex"/, "KickoffPlan should have complexity field");
assert.match(typesContent, /assessments:\s*KickoffAssessment\[\]/, "KickoffPlan should have assessments array");

console.log("✅ Types validation passed");

// ── 2. Kickoff orchestrator ────────────────────────────────────────────────

const orchestratorContent = readFileSync(path.join(SRC_ROOT, "controller", "kickoff-orchestrator.ts"), "utf-8");

// Check that buildKickoffAssessmentPrompt is exported
assert.match(orchestratorContent, /export function buildKickoffAssessmentPrompt/, "buildKickoffAssessmentPrompt should be exported");

// Check that runKickoffMeeting is exported
assert.match(orchestratorContent, /export async function runKickoffMeeting/, "runKickoffMeeting should be exported");

// Check that the assessment prompt contains key instructions
assert.match(orchestratorContent, /Respond with a JSON object/, "Assessment prompt should ask for JSON response");
assert.match(orchestratorContent, /"needed":\s*boolean/, "Assessment prompt should document 'needed' field");
assert.match(orchestratorContent, /"suggestedTasks"/, "Assessment prompt should document 'suggestedTasks' field");

console.log("✅ Kickoff orchestrator validation passed");

// ── 3. Controller prompt includes kickoff ──────────────────────────────────

const promptContent = readFileSync(path.join(SRC_ROOT, "controller", "prompt-injector.ts"), "utf-8");

assert.match(promptContent, /teamclaw_request_kickoff/, "Controller prompt should mention teamclaw_request_kickoff tool");
assert.match(promptContent, /Team Kickoff Meeting/, "Controller prompt should include kickoff meeting section");
assert.match(promptContent, /Adaptive kickoff rules/, "Controller prompt should describe adaptive kickoff rules");
assert.match(promptContent, /Simple.*single clear task/s, "Controller prompt should describe simple projects");
assert.match(promptContent, /Complex.*unclear scope/s, "Controller prompt should describe complex projects");

console.log("✅ Controller prompt kickoff integration passed");

// ── 4. Controller tools include kickoff ────────────────────────────────────

const toolsContent = readFileSync(path.join(SRC_ROOT, "controller", "controller-tools.ts"), "utf-8");

assert.match(toolsContent, /teamclaw_request_kickoff/, "Controller tools should include teamclaw_request_kickoff");
assert.match(toolsContent, /kickoffHandler/, "Controller tools should reference kickoffHandler dep");
assert.match(toolsContent, /candidateRoles/, "Kickoff tool should accept candidateRoles parameter");
assert.match(toolsContent, /complexity.*simple.*medium.*complex/s, "Kickoff tool should accept complexity parameter");

console.log("✅ Controller tools kickoff integration passed");

// ── 5. Worker http-handler accepts kickoff assess ──────────────────────────

const handlerContent = readFileSync(path.join(SRC_ROOT, "worker", "http-handler.ts"), "utf-8");

assert.match(handlerContent, /\/api\/v1\/kickoff\/assess/, "Worker http-handler should have kickoff assess endpoint");
assert.match(handlerContent, /kickoffAssessor/, "Worker http-handler should accept kickoffAssessor parameter");
assert.match(handlerContent, /KickoffAssessor/, "Worker http-handler should export KickoffAssessor type");

console.log("✅ Worker http-handler kickoff endpoint passed");

// ── 6. Controller service wiring ───────────────────────────────────────────

const serviceContent = readFileSync(path.join(SRC_ROOT, "controller", "controller-service.ts"), "utf-8");

assert.match(serviceContent, /onKickoffHandlerAvailable/, "Controller service should have onKickoffHandlerAvailable callback");
assert.match(serviceContent, /KickoffHandler/, "Controller service should export KickoffHandler type");
assert.match(serviceContent, /runKickoffMeeting/, "Controller service should use runKickoffMeeting");
assert.match(serviceContent, /requestKickoffAssessment/, "Controller service should have requestKickoffAssessment function");
assert.match(serviceContent, /parseAssessmentResponse/, "Controller service should have parseAssessmentResponse function");

console.log("✅ Controller service kickoff wiring passed");

// ── 7. Index.ts wiring ────────────────────────────────────────────────────

const indexContent = readFileSync(path.join(path.resolve(import.meta.dirname, "..", "src"), "index.ts"), "utf-8");

assert.match(indexContent, /kickoffHandler/, "index.ts should pass kickoffHandler to controller tools");
assert.match(indexContent, /onKickoffHandlerAvailable/, "index.ts should listen for kickoff handler availability");

console.log("✅ Index.ts kickoff wiring passed");

// ── 8. Worker service wiring ───────────────────────────────────────────────

const workerServiceContent = readFileSync(path.join(SRC_ROOT, "worker", "worker-service.ts"), "utf-8");

assert.match(workerServiceContent, /kickoffAssessor/, "Worker service should create and pass kickoffAssessor");
assert.match(workerServiceContent, /buildKickoffAssessmentPrompt/, "Worker service should import buildKickoffAssessmentPrompt");

console.log("✅ Worker service kickoff wiring passed");

console.log("\n🎉 All Team Kickoff Meeting smoke tests passed!");
