// #221: strip Electron 45 gendered locale variants before signing.
//
// Electron 45 ships gendered locale resources (e.g. da_MASCULINE.lproj,
// af_FEMININE.lproj, am_NEUTER.lproj). Only those variant locale.pak files
// carry pre-existing code signatures, so electron-builder 26.x re-signs
// each one with a secure timestamp round-trip - ~165 extra TSA calls that
// fail the whole build when the timestamp service flakes (see issue #221:
// codesign dies on da_MASCULINE.lproj/locale.pak, "The timestamp service
// is not available").
//
// TeamClaw Desktop ships en/zh UI only and never selects gendered locale
// variants, so removing them is lossless. The afterPack hook runs after
// the .app is assembled and BEFORE codesign, on both the Developer ID
// (dist:mac) and MAS (deploy-mas) signing paths.
import { readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const GENDERED_SUFFIXES = ["MASCULINE", "FEMININE", "NEUTER"];
const GENDERED_LPROJ = new RegExp(
  "_(" + GENDERED_SUFFIXES.join("|") + ")\\.lproj$",
);

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  // ASC encryption question (user-found 2026-11-13): the builder's
  // mas.extendInfo dropped the boolean ITSAppUsesNonExemptEncryption
  // (present in package.json since 7ff8830, still absent from the packed
  // plist per ASC), so every submission hit the export-compliance prompt.
  // Write it directly into the packed plist here - before signing, on both
  // dist and MAS paths. No proprietary encryption ships (system HTTPS only).
  try {
    const outDir = context.appOutDir;
    const appDir = (await readdir(outDir)).find((e) => e.endsWith(".app"));
    if (!appDir) throw new Error(`no .app under ${outDir}`);
    const plist = path.join(outDir, appDir, "Contents", "Info.plist");
    for (const cmd of ["Set :ITSAppUsesNonExemptEncryption false", "Add :ITSAppUsesNonExemptEncryption bool false"]) {
      try {
        execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist], { stdio: "ignore" });
        break;
      } catch { /* try the next form */ }
    }
    const got = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :ITSAppUsesNonExemptEncryption", plist]).toString().trim();
    console.log(`[afterPack] ITSAppUsesNonExemptEncryption = ${got}`);
  } catch (e) {
    console.error(`[afterPack] FAILED to write ITSAppUsesNonExemptEncryption: ${e && e.message}`);
  }
  const frameworksDir = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Frameworks",
  );
  let removed = 0;
  for (const entry of await readdir(frameworksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const resourcesDir = path.join(
      frameworksDir,
      entry.name,
      "Versions",
      "A",
      "Resources",
    );
    let lprojs;
    try {
      lprojs = await readdir(resourcesDir);
    } catch {
      continue; // framework without a Resources dir
    }
    for (const lproj of lprojs) {
      if (GENDERED_LPROJ.test(lproj)) {
        await rm(path.join(resourcesDir, lproj), { recursive: true });
        removed++;
      }
    }
  }
  console.log(`[afterPack] stripped ${removed} gendered .lproj variant dir(s) (Electron 45, issue #221)`);
}
