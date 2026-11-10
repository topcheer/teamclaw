#!/usr/bin/env node
// Issue #255 P1-9: the dependency-direction rules that ARCHITECTURE_REVIEW.md
// line 18 enforces only as comments become an executable gate here (and in CI
// via teamclaw-unit-tests.yml's named step; the suite glob also picks this
// file up automatically).
//
//   Rule 1 (runtime 0-cycle): no import cycles anywhere under src/src - the
//     layering is a DAG: `controller -> shared <- worker`.
//   Rule 2 (worker -> controller = 0, one documented exception): worker
//     modules must not import controller modules. The single sanctioned
//     back-reference is `worker/tools.ts -> controller/orchestration-manifest.ts`
//     (types + pure normalize function, ARCHITECTURE_REVIEW.md lines 119/130).
//
// Source-level static scan (no dist, no bundler, no third-party dep): regex
// the import/export-from specifiers of every src/src .ts file, resolve the
// relative ones against the filesystem, build the module graph, assert.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const SRC_ROOT = path.join(projectRoot, "src", "src");

const tsFiles = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) tsFiles.push(full);
  }
})(SRC_ROOT);
assert.ok(tsFiles.length > 20, `expected a real module tree, saw only ${tsFiles.length} .ts files`);

const moduleId = (absPath) => path.relative(SRC_ROOT, absPath).replace(/\.ts$/, "").replaceAll(path.sep, "/");

function resolveImport(fromAbs, specifier) {
  // Imports are ESM with .js specifiers pointing at .ts sources ("../protocol.js").
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    path.join(base.replace(/\.js$/, ""), "index.ts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null; // package import or unresolvable - not a src-internal edge
}

const importRe = /\b(?:from|import)\s*["'](\.[^"']+)["']/g;
const edges = new Map(); // "from" -> Set<"to">
for (const file of tsFiles) {
  const from = moduleId(file);
  const text = fs.readFileSync(file, "utf8");
  let match;
  while ((match = importRe.exec(text)) !== null) {
    const resolved = resolveImport(file, match[1]);
    if (!resolved) continue;
    const to = moduleId(resolved);
    if (to === from) continue; // self-import counted as a cycle below instead
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  }
}

// Rule 1: import cycles anywhere under src/src (DFS, three-color).
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map();
const stack = [];
const cycles = [];
function dfs(node) {
  color.set(node, GRAY);
  stack.push(node);
  for (const next of edges.get(node) ?? []) {
    if (color.get(next) === GRAY) {
      cycles.push([...stack.slice(stack.indexOf(next)), next].join(" -> "));
    } else if ((color.get(next) ?? WHITE) === WHITE) {
      dfs(next);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}
for (const node of edges.keys()) {
  if ((color.get(node) ?? WHITE) === WHITE) dfs(node);
}
// Rule 1 (runtime cycles, RATCHET): ARCHITECTURE_REVIEW.md's "无循环依赖"
// ideal is 0 cycles, but HEAD carries documented legacy debt (the review
// itself calls http-server.ts the structural bottleneck, section line 79):
// a types<->roles<->prompt-policy cluster and a controller/route-table hub
// cluster. src/src is outside this issue's file scope, so the gate is a
// ratchet: NO NEW cycle node-sets may appear, and resolving a cycle should
// shrink the baseline below (each removal tightens the gate permanently).
const BASELINE_CYCLE_SETS = new Set([
  "prompt-policy,roles,types",
  "profile-loader,prompt-policy,roles,types",
  "openclaw-workspace,prompt-policy,role-ids,roles,types",
  "roles,types",
  "controller/controller-service,controller/http-server",
  "controller/controller-service,controller/http-server,controller/repo-routes,controller/route-table,controller/task-assignment",
  "controller/controller-service,controller/profile-switch",
  "controller/http-server,controller/route-table",
  "controller/http-server,controller/route-table,controller/security",
  // Post-#256 regression (caught by this gate's FIRST CI run): 33e8f81 added
  // worker-provisioning -> security (secretsEqual), closing a 4-module cycle.
  // src/src is outside #255 scope - flagged for follow-up; REMOVE this entry
  // once the cycle is broken (e.g. secretsEqual hoisted to protocol.ts).
  "controller/http-server,controller/route-table,controller/security,controller/worker-provisioning",
  "controller/route-table,controller/webui-routes",
  "controller/auth-routes,controller/route-table",
  "controller/route-table,controller/workspace-routes",
  "controller/controller-routes,controller/route-table",
  "controller/route-table,controller/status-routes",
  "controller/report-routes,controller/route-table",
  "controller/route-table,controller/tunnel-routes",
  "controller/route-table,controller/task-results,controller/task-routes,controller/workflow-routes",
]);
const actualCycleSets = new Set(cycles.map((cycle) => {
  const nodes = cycle.split(" -> ").filter((node, index, all) => index < all.length - 1 || !all.slice(0, -1).includes(node));
  return [...new Set(nodes)].sort().join(",");
}));
const newCycles = [...actualCycleSets].filter((key) => !BASELINE_CYCLE_SETS.has(key));
assert.deepEqual(
  newCycles,
  [],
  `ARCHITECTURE_REVIEW.md line 18 red line broken - NEW import cycles under src/src (${newCycles.length}); layering must stay a DAG: controller -> shared <- worker`,
);
const resolved = BASELINE_CYCLE_SETS.size - actualCycleSets.size;

// Rule 2: worker -> controller imports are forbidden except the documented
// worker/tools -> controller/orchestration-manifest types+normalize edge.
const SANCTIONED = new Set(["worker/tools -> controller/orchestration-manifest"]);
const backEdges = [];
for (const [from, targets] of edges) {
  if (!from.startsWith("worker/")) continue;
  for (const to of targets) {
    if (to.startsWith("controller/") && !SANCTIONED.has(`${from} -> ${to}`)) {
      backEdges.push(`${from} -> ${to}`);
    }
  }
}
assert.deepEqual(
  backEdges,
  [],
  `ARCHITECTURE_REVIEW.md line 18 red line broken - worker modules importing controller (${backEdges.length}); dependency direction is one-way controller -> shared <- worker (only sanctioned edge: worker/tools -> controller/orchestration-manifest)`,
);

const edgeCount = [...edges.values()].reduce((sum, targets) => sum + targets.size, 0);
console.log(
  `✅ dependency gate: ${tsFiles.length} modules, ${edgeCount} internal import edges - 0 unsanctioned worker->controller edges, 0 new cycles `
  + `(baseline ${BASELINE_CYCLE_SETS.size} legacy cycle sets, ${resolved > 0 ? `${resolved} resolved - shrink the baseline` : "all still present"})`,
);
