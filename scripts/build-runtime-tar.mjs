#!/usr/bin/env node
// Builds the self-contained OpenClaw+TeamClaw runtime tarball.
// ONE artifact shape, TWO consumers:
//   - CI: attaches it to the fixed `runtime-latest` release (stable URL)
//   - desktop bundle: scripts/prepare-bundled.mjs runs this same script and
//     extracts into extraResources - bundle and artifact are byte-identical.
// Usage: node scripts/build-runtime-tar.mjs <outDir> [--platform darwin-arm64]
// Version pins: openclaw from the desktop-supported pin, teamclaw from
// src/package.json (same-version release discipline).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const outDir = process.argv[2] || "dist-runtime";
const teamclawVersion = JSON.parse(readFileSync(new URL("../src/package.json", import.meta.url), "utf8")).version;
const openclawVersion = process.env.OPENCLAW_PIN || "latest";

mkdirSync(path.join(outDir, "runtime"), { recursive: true });
console.log(`[runtime-tar] openclaw@${openclawVersion} + @teamclaws/teamclaw@${teamclawVersion}`);
execSync(`npm install --prefix ${path.join(outDir, "runtime")} openclaw@${openclawVersion} @teamclaws/teamclaw@${teamclawVersion}`, { stdio: "inherit" });
writeFileSync(path.join(outDir, "runtime", "RUNTIME-VERSION"), `openclaw@${openclawVersion}\nteamclaw@${teamclawVersion}\n`, "utf8");
const plat = process.platform + "-" + process.arch;
const tar = `teamclaw-runtime-${plat}.tar.gz`;
execSync(`tar czf ${path.join(outDir, tar)} -C ${outDir} runtime`, { stdio: "inherit" });
execSync(`shasum -a 256 ${path.join(outDir, tar)} > ${path.join(outDir, tar)}.sha256`, { stdio: "inherit" });
console.log(`[runtime-tar] ${tar} ready (+.sha256)`);
