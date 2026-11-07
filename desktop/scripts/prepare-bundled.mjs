#!/usr/bin/env node
// Desktop bundle step: build the SAME runtime tar the CI release ships
// (scripts/build-runtime-tar.mjs) and extract it into desktop/build/bundle
// for extraResources embedding. bundle == artifact, byte-identical tree.
//
// Also MATERIALIZES every symlink in the teamclaw plugin tree: electron-
// builder's extraResources copy breaks symlinks, and openclaw's dependency-
// boundary safety scan refuses plugins whose tree contains unresolvable
// links. Real files have nothing to break.
import { execSync } from "node:child_process";
import {
  cpSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  readlinkSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const stage = path.join(here, "..", "build", "bundle-stage");
const out = path.join(here, "..", "build", "bundle");

console.log("[prepare-bundled] building runtime tar (same script as CI release)...");
execSync(`node ${path.join(repoRoot, "scripts", "build-runtime-tar.mjs")} ${JSON.stringify(stage)}`, { stdio: "inherit", cwd: repoRoot });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(stage, "runtime"), path.join(out, "runtime"), { recursive: true });
rmSync(stage, { recursive: true, force: true });

// Materialize symlinks (whole runtime tree - covers plugin and its deps).
let fixed = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.isSymbolicLink()) continue;
    let real = null;
    try { real = realpathSync.native(p); } catch { /* dangling */ }
    if (!real) {
      // Absolute link into the DELETED bundle-stage: the same relative path
      // exists under the final bundle - rewrite the target deterministically
      // instead of guessing the owning package by bin name.
      const target = readlinkSync(p);
      const stageMark = `${path.sep}bundle-stage${path.sep}`;
      const idx = target.indexOf(stageMark);
      if (idx >= 0 && path.isAbsolute(target)) {
        const relocated = path.join(out, target.slice(idx + stageMark.length));
        try { if (statSync(relocated).isFile()) real = relocated; } catch { /* not in bundle */ }
      }
    }
    if (!real) {
      // Dangling .bin link: rebuild by npm convention - .bin/<name> resolves
      // to the target package's package.json "bin" entry, searched among ALL
      // sibling scopes (any @scope dir, not a hardcoded list).
      const binName = entry.name;
      const nmRoot = path.dirname(path.dirname(p)); // .../node_modules
      const pkgDirs = [];
      for (const e of readdirSync(nmRoot, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith("@")) {
          try {
            for (const sub of readdirSync(path.join(nmRoot, e.name), { withFileTypes: true })) {
              if (sub.isDirectory()) pkgDirs.push(path.join(nmRoot, e.name, sub.name));
            }
          } catch { /* unreadable scope */ }
        } else {
          pkgDirs.push(path.join(nmRoot, e.name));
        }
      }
      outer: for (const pkgDir of pkgDirs) {
        const manifest = path.join(pkgDir, "package.json");
        try {
          const bins = JSON.parse(readFileSync(manifest, "utf8")).bin || {};
          for (const [k, v] of Object.entries(bins)) {
            if (k === binName) {
              real = path.join(pkgDir, typeof v === "object" ? v[k] || "" : v);
              break outer;
            }
          }
        } catch { /* no/invalid manifest */ }
      }
    }
    if (!real) continue;
    try {
      const data = readFileSync(real);
      const mode = statSync(real).mode;
      unlinkSync(p);
      writeFileSync(p, data, { mode });
      fixed += 1;
    } catch { /* still unresolvable - scan will report */ }
  }
};
walk(path.join(out, "runtime", "node_modules"));
// ^ the WHOLE runtime tree, matching the header comment. Walking only the
// @teamclaws subtree left top-level node_modules/.bin links pointing into
// the deleted bundle-stage - codesign then dies on the dangling stat.
console.log(`[prepare-bundled] materialized ${fixed} symlinks`);

// Compressed form (user requirement): installers must NOT carry the ~1GB
// unpacked tree. Materialize symlinks FIRST (above), then pack the whole
// tree into runtime.tgz and drop the loose directory - the app extracts it
// to userData on first launch (main.mjs -> runtime-extract.mjs). Materialize
// before tar also means the archive contains zero symlinks, so Windows'
// System32 tar.exe never needs symlink privileges to extract it.
execSync(`tar -czf "${path.join(out, "runtime.tgz")}" -C "${out}" runtime`, { stdio: "inherit" });
rmSync(path.join(out, "runtime"), { recursive: true, force: true });
console.log("[prepare-bundled] bundle archive ready:", path.join(out, "runtime.tgz"));
