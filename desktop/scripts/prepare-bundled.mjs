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
  rmSync, statSync, unlinkSync, writeFileSync,
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
      // Dangling .bin link: rebuild by npm convention - .bin/<name> resolves
      // to the target package's package.json "bin" entry, searched among
      // sibling scopes (node_modules/.bin lives beside the packages).
      const binName = entry.name;
      const nmRoot = path.dirname(path.dirname(p)); // .../node_modules
      const scopes = ["", "@teamclaws/", "@openclaw/"];
      outer: for (const scope of scopes) {
        for (const pkg of readdirSync(nmRoot, { withFileTypes: true })) {
          if (!pkg.isDirectory()) continue;
          const pkgDir = path.join(nmRoot, pkg.name);
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
          // also check scoped nested node_modules (one level)
        }
      }
      if (!real) continue;
    }
    try {
      const data = readFileSync(real);
      const mode = statSync(real).mode;
      unlinkSync(p);
      writeFileSync(p, data, { mode });
      fixed += 1;
    } catch { /* still unresolvable - scan will report */ }
  }
};
walk(path.join(out, "runtime", "node_modules", "@teamclaws"));
console.log(`[prepare-bundled] materialized ${fixed} symlinks`);
console.log("[prepare-bundled] bundle tree ready:", out);
