#!/usr/bin/env node
// #255 P1-6: capability visibility must not 404-trap the desktop.
//
// Defect: the desktop renderer applied zero capability visibility — the
// TeamAuto nav button stayed visible under teamauto:false profiles (banking,
// insurance, securities, trading-co, crossborder-ecom), so its view issued
// GET /teamauto/repo-candidates + GET /teamauto/repos that the controller
// answers with the capability 404 — a visible dead surface. The web UI
// already gated its teamauto tab (applyCapabilitiesVisibility); the desktop
// twin was missing.
//
// Coverage here (source-level pins in the test-desktop-switch-events.mjs
// style + a functional extraction in the test-llm-endpoint-gate.mjs style):
//   - applyActiveTeamProfile funnels through applyCapabilityVisibility so
//     every profile-mirror path (WS switch events, refreshAll, wizard echo)
//     re-applies the gate atomically with the profile swap;
//   - hidden, NOT removed (DOM contract: node stays for tests/i18n);
//   - a desktop sitting on the teamauto view when the gate flips falls back
//     to mission instead of staring at a dead surface;
//   - unknown/missing capabilities default to visible (older controllers +
//     software-rd keep the full nav);
//   - CSS: .nav-btn[hidden] { display: none } — .nav-btn is display:flex so
//     the UA default would NOT hide it (same trap the web UI's .tab hit);
//   - wiring: the teamauto nav button keeps data-view="teamauto" in
//     index.html (hidden-not-removed DOM contract).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.resolve(here, "../renderer");
const appPath = path.join(rendererDir, "app.js");
const htmlPath = path.join(rendererDir, "index.html");
const cssPath = path.join(rendererDir, "style.css");

const src = fs.readFileSync(appPath, "utf8");
const html = fs.readFileSync(htmlPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

// Syntax gate (the smoke suite's check on entrypoints).
execFileSync(process.execPath, ["--check", appPath]);

// Balanced-brace extraction in the test-desktop-switch-events.mjs style.
function extractFunctionBody(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `renderer must define ${name}()`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}()`);
}

// ---------------------------------------------------------------------------
// 1. Wiring: the single profile-mirror apply point calls the visibility gate.
// ---------------------------------------------------------------------------
const applyProfileBody = extractFunctionBody(src, "applyActiveTeamProfile");
assert.ok(
  applyProfileBody.includes("applyCapabilityVisibility(profileInfo)"),
  "applyActiveTeamProfile must funnel through applyCapabilityVisibility (every profile swap re-applies the gate)",
);

// ---------------------------------------------------------------------------
// 2. Gate shape: hidden-not-removed + mission fallback + visible default.
// ---------------------------------------------------------------------------
const gateBody = extractFunctionBody(src, "applyCapabilityVisibility");
assert.match(
  gateBody,
  /caps\.teamauto !== false/,
  "the gate must default to visible when capabilities are unknown/absent (older controllers, software-rd)",
);
assert.match(
  gateBody,
  /navBtn\.hidden = !teamautoEnabled/,
  "the teamauto nav button must be hidden via the hidden property, not removed",
);
assert.match(
  gateBody,
  /state\.currentView === "teamauto"/,
  "the gate must notice when the CURRENT view is the newly gated one",
);
assert.match(
  gateBody,
  /activateView\("mission"\)/,
  "a desktop sitting on the gated view falls back to mission, not a dead surface",
);

// ---------------------------------------------------------------------------
// 3. Functional check: exercise the gate against a synthetic DOM (the
//    test-llm-endpoint-gate.mjs extraction style, with the two DOM touch
//    points stubbed so the branch outcomes are observable).
// ---------------------------------------------------------------------------
const gateSrc = src.match(/function applyCapabilityVisibility\(profileInfo\)\s*\{[\s\S]*?\n  \}/)[0];
const runGate = new Function("document", "state", "activateView", `
  ${gateSrc.replace(/function applyCapabilityVisibility\(profileInfo\)/, "return function(profileInfo)")}
`)();
function makeDom() {
  return {
    navBtn: { hidden: false },
    querySelector(sel) { return sel === '.nav-btn[data-view="teamauto"]' ? this.navBtn : null; },
  };
}
const cases = [
  ["banking all-off", { profile: { capabilities: { git: false, teamauto: false, runnablePreview: false, deliveryReview: false } } }, true],
  ["software-rd all-on", { profile: { capabilities: { git: true, teamauto: true, runnablePreview: true, deliveryReview: true } } }, false],
  ["capabilities absent (older controller)", { profile: {} }, false],
  ["profileInfo null", null, false],
];
for (const [label, profileInfo, expectHidden] of cases) {
  const document = makeDom();
  const state = { currentView: "tasks" };
  let fallback = null;
  runGate.call(null, profileInfo);
  // Re-run bound to the stubs (the extracted fn closes over nothing else).
  const document2 = makeDom();
  const state2 = { currentView: "teamauto" };
  let fallback2 = null;
  const bound = (info) => new Function("document", "state", "activateView", `
    ${gateSrc.replace(/function applyCapabilityVisibility\(profileInfo\)/, "return function(profileInfo)")}
  `)(document2, state2, (v) => { fallback2 = v; })(info);
  bound(profileInfo);
  assert.equal(document2.navBtn.hidden, expectHidden, `${label}: nav hidden must be ${expectHidden}`);
  if (expectHidden && state2.currentView === "teamauto") {
    assert.equal(fallback2, "mission", `${label}: current teamauto view must fall back to mission`);
  } else {
    assert.equal(fallback2, null, `${label}: no view change expected while off the gated view`);
  }
}

// ---------------------------------------------------------------------------
// 4. CSS: the hidden attribute must actually hide (nav-btn is display:flex).
// ---------------------------------------------------------------------------
assert.match(
  css,
  /\.nav-btn\[hidden\]\s*\{\s*display:\s*none;/,
  "style.css must enforce display:none for hidden nav buttons (.nav-btn sets display:flex)",
);

// ---------------------------------------------------------------------------
// 5. DOM contract: the teamauto nav button node stays in index.html.
// ---------------------------------------------------------------------------
assert.ok(
  html.includes('data-view="teamauto"'),
  "index.html must KEEP the teamauto nav button node (hidden, not removed)",
);

console.log("test-capability-visibility: ok (desktop capability visibility wired + branch coverage)");
