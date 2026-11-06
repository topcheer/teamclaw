#!/usr/bin/env node
// Cross-platform runtime staging for desktop bundles.
// Unlike prepare-bundled.mjs (which builds the darwin tar via
// build-runtime-tar.mjs on the host), this stages the runtime DIRECTLY for
// any target platform, so CI runners and cross-builds get correct platform
// natives (fs-safe-<plat>-<arch>, @esbuild/<plat>-<arch>, ...):
//
//   TC_OS / TC_CPU   target platform (default: host)
//   OPENCLAW_PIN     openclaw version (default: latest)
//
// npm install runs with --ignore-scripts ON PURPOSE: koffi's cnoke native
// build breaks cross-compilation (and needs a C toolchain even natively);
// koffi is only referenced by the imap extension, the gateway core path
// never loads it. Everything else ships prebuilt platform binaries via
// optionalDependencies, which --os/--cpu selects correctly.
//
// Afterwards every in-tree symlink is materialized to a real file:
// electron-builder's extraResources copy breaks links, and openclaw's
// dependency-boundary scan refuses unresolvable ones.
import { execSync } from "node:child_process";
import {
  mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "build", "bundle");
const teamclawVersion = JSON.parse(readFileSync(new URL("../../src/package.json", import.meta.url), "utf8")).version;
const openclawVersion = process.env.OPENCLAW_PIN || "latest";
const tcOs = process.env.TC_OS || process.platform;
const tcCpu = process.env.TC_CPU || process.arch;
const hostOs = process.platform;

rmSync(path.join(out, "runtime"), { recursive: true, force: true });
mkdirSync(path.join(out, "runtime"), { recursive: true });

const cross = [];
if (tcOs !== hostOs || (process.env.TC_CPU && process.env.TC_CPU !== process.arch)) {
  cross.push("--os", tcOs, "--cpu", tcCpu);
}
console.log(`[prepare-bundle] openclaw@${openclawVersion} + @teamclaws/teamclaw@${teamclawVersion} for ${tcOs}-${tcCpu}${cross.length ? " (cross)" : ""}`);
execSync(
  `npm install --prefix ${JSON.stringify(path.join(out, "runtime"))} ${cross.join(" ")} --ignore-scripts --no-audit --no-fund openclaw@${openclawVersion} @teamclaws/teamclaw@${teamclawVersion}`,
  { stdio: "inherit" },
);
writeFileSync(path.join(out, "runtime", "RUNTIME-VERSION"), `openclaw@${openclawVersion}\nteamclaw@${teamclawVersion}\n`, "utf8");

// Materialize symlinks across the whole runtime tree. In-tree links become
// real files; dangling .bin links are rebuilt via the npm bin convention.
let fixed = 0, rebuilt = 0, dropped = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (!entry.isSymbolicLink()) continue;
    let real = null;
    try { real = realpathSync.native(p); } catch { /* dangling */ }
    if (!real) {
      const binName = entry.name;
      const nmRoot = path.dirname(path.dirname(p));
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
        try {
          const bins = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).bin || {};
          for (const [k, v] of Object.entries(bins)) {
            if (k === binName) {
              real = path.join(pkgDir, typeof v === "object" ? v[k] || "" : v);
              break outer;
            }
          }
        } catch { /* no/invalid manifest */ }
      }
      if (!real) { try { unlinkSync(p); dropped += 1; } catch { /* gone */ } continue; }
    }
    if (!real.startsWith(out)) {
      // Points outside the bundle (host node_modules etc.) - drop it; the
      // boundary scan treats unresolvable links as fatal, absent as fine.
      try { unlinkSync(p); dropped += 1; } catch { /* gone */ }
      continue;
    }
    try {
      const data = readFileSync(real);
      const mode = statSync(real).mode;
      unlinkSync(p);
      writeFileSync(p, data, { mode });
      fixed += 1;
    } catch { /* keep link */ }
  }
};
walk(path.join(out, "runtime"));
console.log(`[prepare-bundle] symlinks: materialized=${fixed + rebuilt} dropped-out-of-tree=${dropped}`);
console.log(`[prepare-bundle] bundle tree ready: ${out}`);
