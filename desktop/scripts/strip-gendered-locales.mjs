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
import path from "node:path";

const GENDERED_SUFFIXES = ["MASCULINE", "FEMININE", "NEUTER"];
const GENDERED_LPROJ = new RegExp(
  "_(" + GENDERED_SUFFIXES.join("|") + ")\\.lproj$",
);

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
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
