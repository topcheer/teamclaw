#!/usr/bin/env node
// #150 behavioral pin: the bundled-install dependency seal.
//
// Extracts the REAL seal code from desktop/main.mjs (the sealDir block) and
// runs it against a synthetic bundled tree, so the production algorithm -
// not a copy of it - is what gets exercised. If the main.mjs shape changes,
// extraction fails loudly and this test must be updated consciously.
//
// Pins (all learned from live offline repros):
//   #147/#150 full-closure seal: every real package dir (incl. scoped) is
//     copied into <state>/extensions/teamclaw/node_modules; .bin, the lock
//     file, manifest-less dirs, plain files, and symlink entries are not.
//   #147 fault isolation: a package whose copy fails must be counted as
//     skipped while every other package still lands (the original
//     whole-tree cp died silently after ~10 entries).
//   idempotency: a second run over an already-sealed tree copies nothing.

import assert from "node:assert/strict";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const mainSource = await fsp.readFile(path.join(projectRoot, "desktop", "main.mjs"), "utf8");

// --- extract the production seal block -------------------------------------
const sealMatch = mainSource.match(/let sealed = 0, skipped = 0;[\s\S]*?Deps sealed: \$\{sealed\} packages \(\$\{skipped\} skipped\)\.` \}\);/);
assert.ok(
  sealMatch,
  "desktop/main.mjs must keep the seal block (let sealed = 0, skipped = 0; ... Deps sealed: ...) - update this test together with the seal",
);
const sealSource = sealMatch[0];

async function runSeal(runtimeNM, extDeps, onEvent, cpOverride) {
  const fs = { readdir: fsp.readdir, cp: cpOverride || fsp.cp };
  const fn = new Function(
    "fs", "fsSync", "path", "runtimeNM", "extDeps", "onEvent",
    `"use strict"; return (async () => {\n${sealSource}\n return { sealed, skipped };\n})();`,
  );
  return fn(fs, fsSync, path, runtimeNM, extDeps, onEvent);
}

// --- fixture: a miniature bundled runtime tree -----------------------------
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tc-seal-"));
try {
  const runtimeNM = path.join(tmp, "runtime", "node_modules");
  const extDeps = path.join(tmp, "state", "extensions", "teamclaw", "node_modules");

  const pkg = async (dir, extra = {}) => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: path.basename(dir) }));
    for (const [name, body] of Object.entries(extra)) {
      await fsp.writeFile(path.join(dir, name), body);
    }
  };
  await pkg(path.join(runtimeNM, "fast-deep-equal"), { "index.js": "module.exports=require('./x')" });
  await pkg(path.join(runtimeNM, "bonjour-service"));
  await pkg(path.join(runtimeNM, "@scope", "pkg"), { "lib.js": "export {}" });
  await pkg(path.join(runtimeNM, "@teamclaws", "teamclaw"));
  // Entries that must NOT be sealed:
  await fsp.mkdir(path.join(runtimeNM, ".bin"), { recursive: true }); // bin shims
  await fsp.writeFile(path.join(runtimeNM, ".package-lock.json"), "{}"); // lockfile
  await fsp.mkdir(path.join(runtimeNM, "manifest-less-dir"), { recursive: true }); // no package.json
  await fsp.writeFile(path.join(runtimeNM, "stray-file"), "x"); // plain file
  await fsp.symlink(path.join(runtimeNM, "fast-deep-equal"), path.join(runtimeNM, "symlinked-pkg")); // symlink entry
  // Already sealed on a previous run - must be left untouched:
  await pkg(path.join(extDeps, "already-there"));
  await fsp.writeFile(path.join(extDeps, "already-there", "package.json"), '{"name":"old-copy"}');

  // --- run 1: the seal itself ------------------------------------------------
  const events = [];
  const r1 = await runSeal(runtimeNM, extDeps, (e) => events.push(e), undefined);

  assert.equal(r1.sealed, 4, `run 1 should seal the 4 real packages (got ${r1.sealed})`);
  assert.equal(r1.skipped, 0, "run 1 should skip nothing on a healthy tree");
  for (const rel of ["fast-deep-equal", "bonjour-service", path.join("@scope", "pkg"), path.join("@teamclaws", "teamclaw")]) {
    assert.ok(fsSync.existsSync(path.join(extDeps, rel, "package.json")), `sealed tree must contain ${rel}`);
  }
  assert.equal(
    await fsp.readFile(path.join(extDeps, "fast-deep-equal", "index.js"), "utf8"),
    "module.exports=require('./x')",
    "copied package content must be intact",
  );
  for (const banned of [".bin", ".package-lock.json", "manifest-less-dir", "stray-file", "symlinked-pkg"]) {
    assert.ok(!fsSync.existsSync(path.join(extDeps, banned)), `sealed tree must NOT contain ${banned}`);
  }
  assert.equal(
    await fsp.readFile(path.join(extDeps, "already-there", "package.json"), "utf8"),
    '{"name":"old-copy"}',
    "an already-present package must not be re-copied over",
  );
  assert.ok(
    events.some((e) => /Deps sealed: 4 packages \(0 skipped\)\./.test(e.line || "")),
    "seal must report the sealed/skip counts through onEvent",
  );

  // --- run 2: idempotent re-run ----------------------------------------------
  const r2 = await runSeal(runtimeNM, extDeps, () => {}, undefined);
  assert.equal(r2.sealed, 0, "re-running the seal over a sealed tree must copy nothing");

  // --- run 3: per-package fault isolation (#147 lesson) ----------------------
  const tmp2 = await fsp.mkdtemp(path.join(os.tmpdir(), "tc-seal2-"));
  try {
    const extDeps2 = path.join(tmp2, "state", "extensions", "teamclaw", "node_modules");
    const failingCp = async (src) => {
      if (src.includes("bonjour-service")) throw new Error("EIO: simulated read failure");
      return fsp.cp(src, path.join(extDeps2, path.relative(runtimeNM, src)), { recursive: true, verbatimSymlinks: true, force: true });
    };
    const r3 = await runSeal(runtimeNM, extDeps2, () => {}, failingCp);
    assert.equal(r3.sealed, 3, "a failing package must not stop the others from sealing");
    assert.equal(r3.skipped, 1, "the failing package must be counted as skipped");
    assert.ok(!fsSync.existsSync(path.join(extDeps2, "bonjour-service")), "the failed package must not land");
    assert.ok(fsSync.existsSync(path.join(extDeps2, "fast-deep-equal")), "healthy packages must still land");
  } finally {
    await fsp.rm(tmp2, { recursive: true, force: true });
  }

  console.log("PASS test-bundled-dep-seal");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
