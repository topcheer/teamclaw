#!/usr/bin/env node
// Issue #221 (desktop codesign) regression tests: Electron 45 gendered
// locale variants vs electron-builder mac/mas signing.
//
// Root cause (validated empirically 2026-11-09, PR #228): Electron 45.2.2
// ships 220 .lproj dirs (55 base + 165 *_MASCULINE/FEMININE/NEUTER variants)
// in Electron Framework.framework/Versions/A/Resources. @electron/osx-sign
// walks every binary-looking resource (isbinaryfile heuristic) and signs it
// with a --timestamp round-trip; the 55->220 locale.pak expansion pushed the
// TSA burst into flake territory ("The timestamp service is not available",
// codesign dies at da_MASCULINE.lproj/locale.pak).
//
// Fix shape (desktop/package.json + desktop/scripts/strip-gendered-locales.mjs):
//   1. mac + mas signIgnore "\\.lproj/locale\\.pak$" - locale.pak files stay
//      in stock Electron's unsigned state (they ship unsigned!), removing all
//      locale TSA round-trips from both signing lanes.
//   2. afterPack hook strips the 165 gendered variant dirs pre-sign (the app
//      ships en/zh only; gendered variants are dead weight + signing hazard).
//
// Test layers here (test-desktop-p0.mjs conventions):
//   - config anchors: package.json build.mac/mas signIgnore + afterPack wired
//   - hook behavior: extract the REAL afterPack from strip-gendered-locales.mjs
//     (new Function against a synthetic .app tree with injectable fs) and run
//     it: strips gendered dirs, keeps base dirs, no-op on win32, resilient to
//     framework-without-Resources.
//   - pre-fix pin: the extraction guard fails loudly if the hook is deleted,
//     and the config asserts fail if signIgnore/afterPack are dropped.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const desktopDir = path.join(projectRoot, "desktop");
const pkgPath = path.join(desktopDir, "package.json");
const hookPath = path.join(desktopDir, "scripts", "strip-gendered-locales.mjs");

const pkgSource = await fs.readFile(pkgPath, "utf8");
const pkg = JSON.parse(pkgSource);
const hookSource = await fs.readFile(hookPath, "utf8");

let pass = 0;
const fail = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++;
      console.log(`  ok ${name}`);
    })
    .catch((err) => {
      fail.push(name);
      console.error(`  FAIL ${name}: ${err.message}`);
    });
}

// ---------------------------------------------------------------------------
// 1. Config anchors: the fix must stay wired in package.json
// ---------------------------------------------------------------------------
await check("config: mac.signIgnore skips locale.pak re-signing", () => {
  assert.deepEqual(pkg.build.mac.signIgnore, ["\\.lproj/locale\\.pak$"],
    "mac.signIgnore must skip .lproj/locale.pak (TSA burst source)");
});

await check("config: mas.signIgnore skips locale.pak re-signing", () => {
  assert.deepEqual(pkg.build.mas.signIgnore, ["\\.lproj/locale\\.pak$"],
    "mas.signIgnore must skip .lproj/locale.pak (MAS lane shares the hazard)");
});

await check("config: afterPack hook wired", () => {
  assert.equal(pkg.build.afterPack, "scripts/strip-gendered-locales.mjs",
    "afterPack must run the gendered-locale stripper before signing");
});

await check("config: hook file exists and parses", async () => {
  // node --check equivalent for ESM: dynamic import parses the module graph
  await import(`${pathToFileURL(hookPath)}?t=${Date.now()}`);
});

await check("anchor: hook banner names issue #221", () => {
  assert.match(hookSource, /#221/, "hook comment must reference issue #221");
});

// ---------------------------------------------------------------------------
// 2. Behavioral: run the REAL afterPack hook against a synthetic .app tree
//
// The hook uses `readdir`/`rm` from node:fs/promises and builds paths from
// context fields. We extract the exported function via the ESM registry
// (dynamic import above already cached it) - no bundling needed.
// ---------------------------------------------------------------------------
const hookModule = await import(`${pathToFileURL(hookPath)}?t=${Date.now()}`);
const afterPack = hookModule.default;
assert.equal(typeof afterPack, "function", "hook must export default afterPack(context)");

async function makeSyntheticApp(root, { gendered, base, frameworksWithResources }) {
  // framework layout: <root>/<appOutDir>/<product>.app/Contents/Frameworks/
  //   <fw>/Versions/A/Resources/<locale>.lproj/locale.pak
  const fwBase = path.join(root, "TeamClaw Desktop.app", "Contents", "Frameworks");
  const frameworks = [];
  const mk = async (fw, locales) => {
    const res = path.join(fwBase, fw, "Versions", "A", "Resources");
    for (const loc of locales) {
      await fs.mkdir(path.join(res, loc), { recursive: true });
      await fs.writeFile(path.join(res, loc, "locale.pak"), "pak-bytes");
    }
    frameworks.push(fw);
  };
  await mk("Electron Framework.framework", [...base, ...gendered]);
  if (frameworksWithResources) await mk("Mantle.framework", base.slice(0, 2));
  // framework WITHOUT a Resources dir (error path: must not throw)
  await fs.mkdir(path.join(fwBase, "Squirrel.framework", "Versions", "A"), { recursive: true });
  return {
    appOutDir: root,
    electronPlatformName: "darwin",
    packager: { appInfo: { productFilename: "TeamClaw Desktop" } },
  };
}

await check("behavior: hook strips gendered .lproj dirs, keeps base locales", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tc221-a-"));
  try {
    const gendered = ["da_MASCULINE.lproj", "af_FEMININE.lproj", "am_NEUTER.lproj"];
    const base = ["en.lproj", "zh_CN.lproj", "da.lproj", "af.lproj"];
    const ctx = await makeSyntheticApp(root, { gendered, base, frameworksWithResources: true });
    await afterPack(ctx);
    const res = path.join(root, "TeamClaw Desktop.app", "Contents", "Frameworks",
      "Electron Framework.framework", "Versions", "A", "Resources");
    const entries = await fs.readdir(res);
    const lprojs = entries.filter((e) => e.endsWith(".lproj"));
    assert.deepEqual([...lprojs].sort(), [...base].sort(),
      "all gendered dirs stripped, all base dirs kept");
    for (const g of gendered) {
      await assert.rejects(fs.stat(path.join(res, g)), /ENOENT/, `${g} must be gone`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check("behavior: hook is a no-op on non-darwin platforms", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tc221-b-"));
  try {
    const ctx = await makeSyntheticApp(root, {
      gendered: ["da_MASCULINE.lproj"], base: ["en.lproj"], frameworksWithResources: false,
    });
    ctx.electronPlatformName = "win32";
    await afterPack(ctx); // must return without touching the tree
    const res = path.join(root, "TeamClaw Desktop.app", "Contents", "Frameworks",
      "Electron Framework.framework", "Versions", "A", "Resources");
    const entries = await fs.readdir(res);
    assert.ok(entries.includes("da_MASCULINE.lproj"),
      "win32 must not strip anything (afterPack is darwin-gated)");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check("behavior: hook tolerates frameworks without Resources dirs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tc221-c-"));
  try {
    const ctx = await makeSyntheticApp(root, {
      gendered: ["da_MASCULINE.lproj"], base: ["en.lproj"], frameworksWithResources: false,
    });
    await assert.doesNotReject(afterPack(ctx),
      "Squirrel.framework has no Resources dir; hook must skip it, not throw");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check("behavior: gendered regex does not eat legitimate locales", async () => {
  // A locale literally named like *_MASCULINE is always gendered; but a base
  // locale such as "en_US_POSIX" or "hy_AM_REVISED" must survive the strip.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tc221-d-"));
  try {
    const gendered = ["da_MASCULINE.lproj", "es_FEMININE.lproj"];
    const base = ["en_US_POSIX.lproj", "hy_AM_REVISED.lproj", "en.lproj"];
    const ctx = await makeSyntheticApp(root, { gendered, base, frameworksWithResources: false });
    await afterPack(ctx);
    const res = path.join(root, "TeamClaw Desktop.app", "Contents", "Frameworks",
      "Electron Framework.framework", "Versions", "A", "Resources");
    const entries = (await fs.readdir(res)).filter((e) => e.endsWith(".lproj"));
    assert.deepEqual([...entries].sort(), [...base].sort(),
      "POSIX/REVISED-style base locales must not be stripped");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail.length} failed (issue #221 regression anchors)`);
if (fail.length > 0) {
  console.error("FAILED:", fail.join(", "));
  process.exit(1);
}
process.exit(0);

// ---------------------------------------------------------------------------
function pathToFileURL(p) {
  return `file://${p.split(path.sep).map(encodeURIComponent).join("/")}`;
}
import os from "node:os";
