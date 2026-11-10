#!/usr/bin/env node
// Issue #255 P1-9: the dependency-direction rules that ARCHITECTURE_REVIEW.md
// line 18 enforces only as comments become an executable gate here (and in CI
// via teamclaw-unit-tests.yml's named step; the suite glob also picks this
// file up automatically).
//
//   Rule 1 (runtime 0-cycle, RATCHET): no import cycles anywhere under src/src
//     - the layering is a DAG: `controller -> shared <- worker`. HEAD carries
//     documented legacy debt (the review itself calls http-server.ts the
//     structural bottleneck, line 79), and src/src is outside #255's file
//     scope, so the gate is a ratchet over STRONGLY-CONNECTED COMPONENTS:
//     the set of multi-node SCCs must never grow - no NEW SCC, and no
//     existing SCC absorbing new members (both change the sorted member key
//     and fail the gate). Breaking an SCC lets you delete its key from the
//     baseline, tightening the ratchet permanently.
//     SCC semantics are order-independent by construction (Tarjan), unlike
//     the first draft's simple-cycle enumeration, whose reported paths
//     depended on readdir order and missed cycles on one machine while
//     catching them on another.
//   Rule 2 (worker -> controller = 0, one documented exception): worker
//     modules must not import controller modules. The single sanctioned
//     back-reference is `worker/tools.ts -> controller/orchestration-manifest.ts`
//     (types + pure normalize function, ARCHITECTURE_REVIEW.md lines 119/130).
//
// Source-level static scan (no dist, no bundler, no third-party dep).
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
    if (to === from) continue;
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from).add(to);
  }
}

// --- SCC via mutual reachability (transitive-closure fixpoint) -------------
// Deliberately NOT a hand-rolled Tarjan: the first iterative attempt silently
// missed SCC members and under-reported the controller hub. A closure
// fixpoint is harder to get wrong and is order-independent by construction;
// on ~90 nodes the extra cost is irrelevant. NOTE: type-only imports count
// as edges - tsc still requires the target module to exist and compile.
const allNodes = new Set(tsFiles.map(moduleId));
for (const [from, targets] of edges) {
  allNodes.add(from);
  for (const to of targets) allNodes.add(to);
}
const reach = new Map();
for (const node of allNodes) reach.set(node, new Set([node]));
let changed = true;
while (changed) {
  changed = false;
  for (const [from, targets] of edges) {
    const fromReach = reach.get(from);
    for (const to of targets) {
      for (const member of reach.get(to)) {
        if (!fromReach.has(member)) {
          fromReach.add(member);
          changed = true;
        }
      }
    }
  }
}
const sccs = [];
const assigned = new Set();
for (const node of allNodes) {
  if (assigned.has(node)) continue;
  const members = [node];
  for (const other of allNodes) {
    if (other !== node && reach.get(node).has(other) && reach.get(other).has(node)) {
      members.push(other);
      assigned.add(other);
    }
  }
  assigned.add(node);
  if (members.length > 1) sccs.push(members);
}
const sccKey = (members) => [...members].sort().join(",");
const actualSccs = new Set(sccs.map(sccKey));

// Baseline: the multi-node SCCs of src/src at #255 time. An actual SCC PASSES
// when its member set is contained in some baseline entry - identical key, or
// a pure SHRINK of one (e.g. the follow-up hoist of secretsEqual to
// protocol.ts will shrink the grown controller hub back; that improvement
// must not trip the gate). A violation is an actual SCC contained in NO
// baseline entry: a brand-new cycle, or an existing SCC that GREW by absorbing
// members (post-#256 the controller hub absorbed worker-provisioning via the
// secretsEqual import - caught by this gate's first CI run; the grown shape is
// pinned below as the largest controller-hub entry).
// Breaking/shrinking an SCC: please replace the baseline entry with the new
// smaller member set - each replacement tightens the ratchet permanently.
const BASELINE_SCCS = [
  // The controller route hub (http-server <-> route-table <-> every route
  // module, mostly via type-only RouteContext imports). Post-8371f70 the
  // secretsEqual hoist freed worker-provisioning from this SCC; shrinking it
  // further means deleting members from this entry.
  "controller/auth-routes,controller/clarification-routes,controller/controller-intake,controller/controller-planning,controller/controller-routes,controller/controller-service,controller/http-server,controller/profile-switch,controller/repo-routes,controller/report-routes,controller/route-table,controller/security,controller/status-routes,controller/task-assignment,controller/task-results,controller/task-routes,controller/tunnel-routes,controller/webui-routes,controller/worker-routes,controller/workflow-routes,controller/workspace-routes".split(","),
  // The types spine cluster: types <-> roles <-> prompt-policy (+ the
  // profile-loader / openclaw-workspace / role-ids spokes it absorbed).
  "openclaw-workspace,profile-loader,prompt-policy,role-ids,roles,types".split(","),
];
const violations = [];
for (const scc of sccs) {
  const contained = BASELINE_SCCS.some((baseline) => scc.every((member) => baseline.includes(member)));
  if (!contained) violations.push(sccKey(scc));
}
assert.deepEqual(
  violations,
  [],
  `ARCHITECTURE_REVIEW.md line 18 red line broken - NEW or GROWN import SCCs under src/src (${violations.length}); layering must stay a DAG: controller -> shared <- worker`,
);

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
  `✅ dependency gate: ${tsFiles.length} modules, ${edgeCount} internal import edges - 0 unsanctioned worker->controller edges, `
  + `${actualSccs.size} multi-node SCCs all within baseline (${BASELINE_SCCS.length} entries}):`,
);
for (const key of [...actualSccs].sort()) console.log(`  - SCC [${key}]`);
