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
// #release-race: desktop/MAS fire on the same tag as the npm release
// workflow - the runtime install needs @teamclaws/teamclaw@<version> which
// is often still unpublished (v2026.11.3: desktop started 03:50Z, publish
// landed 03:59Z) or propagating (dist-tags flipped ~40min after publish).
// Poll availability, then install with transient retries.
const npmInstall = () => execSync(
  `npm install --prefix ${JSON.stringify(path.join(out, "runtime"))} ${cross.join(" ")} --ignore-scripts --no-audit --no-fund openclaw@${openclawVersion} @teamclaws/teamclaw@${teamclawVersion}`,
  { stdio: "inherit" },
);
const pkgAvailable = (spec) => {
  try {
    execSync(`npm view ${spec} version --silent`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const waitDeadline = Date.now() + Number(process.env.RUNTIME_STAGE_WAIT_MS || 45 * 60_000);
const tcSpec = `@teamclaws/teamclaw@${teamclawVersion}`;
let attempt = 0;
// eslint-disable-next-line no-constant-condition
while (true) {
  attempt += 1;
  try {
    if (!pkgAvailable(tcSpec)) {
      throw new Error(`package not visible on the registry yet: ${tcSpec}`);
    }
    npmInstall();
    break;
  } catch (err) {
    if (Date.now() > waitDeadline) {
      console.error(`[prepare-bundle] giving up after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4));
    console.log(`[prepare-bundle] attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${Math.round(backoff / 1000)}s`);
    execSync(`sleep ${Math.round(backoff / 1000)}`, { stdio: "ignore" });
  }
}
writeFileSync(path.join(out, "runtime", "RUNTIME-VERSION"), `openclaw@${openclawVersion}\nteamclaw@${teamclawVersion}\n`, "utf8");

// Prune foreign-platform packages. The npm tree carries optional native
// packages for EVERY platform (@esbuild/win32-x64, @openclaw/fs-safe-linux-*,
// pi-tui/native/<os>/prebuilds). On macOS those foreign Mach-O/PE files
// (a) bloat the bundle and (b) drag @electron/osx-sign through thousands of
// extra binaries - the CI Package step ground >1h on them (run 42142275888).
// Rule: a package dir whose NAME carries a platform[-arch] tag that is not
// the target gets pruned; a prebuilds/<os>-<arch>/ or native/<os>/ dir for a
// foreign os gets pruned. Everything else is untouched.
const osNames = { darwin: "darwin", win32: "win32", linux: "linux" };
const tc = osNames[tcOs] || tcOs;
const arch = tcCpu;
const nm = path.join(out, "runtime", "node_modules");
const OS_TAG = /(darwin|linux|win32|freebsd|android|sunos)(?:[-_](arm64|x64|armv7l|ia32))?/;
let prunedDirs = 0;
const pruneDir = (p) => { rmSync(p, { recursive: true, force: true }); prunedDirs += 1; };
// 1) platform-tagged package dirs, top level and one @scope deep.
const scanPkgs = (dir, depth) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    const m = e.name.match(OS_TAG);
    if (m) {
      const foreign = m[1] !== tc || (m[2] && m[2] !== arch);
      if (foreign) { pruneDir(p); continue; }
    }
    if (e.name.startsWith("@") && depth === 0) scanPkgs(p, 1);
  }
};
scanPkgs(nm, 0);
// 2) prebuilds/<os>-<arch>/ and pi-tui native/<os>/ subtrees, any depth.
const prebuildRoots = [];
const findPrebuilds = (dir, depth) => {
  if (depth > 5) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const en of entries) {
    const p = path.join(dir, en.name);
    if (!en.isDirectory()) continue;
    if (en.name === "prebuilds" || (en.name === "native" && dir.endsWith("pi-tui"))) prebuildRoots.push(p);
    else if (!en.name.startsWith(".")) findPrebuilds(p, depth + 1);
  }
};
findPrebuilds(nm, 0);
for (const pb of prebuildRoots) {
  let entries;
  try { entries = readdirSync(pb, { withFileTypes: true }); } catch { continue; }
  for (const en of entries) {
    if (!en.isDirectory()) continue;
    const os = en.name.split("-")[0];
    if (os !== tc) pruneDir(path.join(pb, en.name));
  }
}
console.log(`[prepare-bundle] pruned ${prunedDirs} foreign-platform dirs (target ${tc}-${arch})`);

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

// #win-tgz (user report 2026-11-14): the compressed-form requirement
// ("installers must NOT carry the ~1GB unpacked tree" - see
// prepare-bundled.mjs) was implemented on the darwin host path only. This
// CI stager - which desktop-release.yml runs for ALL platforms - left the
// loose tree in build/bundle, so Windows/Linux installers unpacked tens of
// thousands of node_modules files on install (NSIS per-file decompress +
// Defender scans on unsigned files = multi-minute installs). Pack to
// runtime.tgz here too: runtime-extract.mjs already prefers tgz and
// extracts to userData on first launch; materialization above guarantees
// zero symlinks, so Windows' System32 tar.exe needs no symlink privileges.
execSync(`tar -czf ${JSON.stringify(path.join(out, "runtime.tgz"))} -C ${JSON.stringify(out)} runtime`, { stdio: "inherit" });
rmSync(path.join(out, "runtime"), { recursive: true, force: true });
console.log("[prepare-bundle] bundle archive ready:", path.join(out, "runtime.tgz"));
