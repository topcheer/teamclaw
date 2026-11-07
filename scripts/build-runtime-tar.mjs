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
import { createHash } from "node:crypto";
import path from "node:path";

const outDir = process.argv[2] || "dist-runtime";
const teamclawVersion = JSON.parse(readFileSync(new URL("../src/package.json", import.meta.url), "utf8")).version;
const openclawVersion = process.env.OPENCLAW_PIN || "latest";
// Local builds can override the teamclaw source (e.g. TEAMCLAW_SPEC=file:../src)
// to bundle the working tree instead of the published npm release.
const teamclawSpec = process.env.TEAMCLAW_SPEC || `@teamclaws/teamclaw@${teamclawVersion}`;

mkdirSync(path.join(outDir, "runtime"), { recursive: true });
console.log(`[runtime-tar] openclaw@${openclawVersion} + ${teamclawSpec}`);
execSync(`npm install --prefix ${path.join(outDir, "runtime")} openclaw@${openclawVersion} ${JSON.stringify(teamclawSpec)}`, { stdio: "inherit" });
writeFileSync(path.join(outDir, "runtime", "RUNTIME-VERSION"), `openclaw@${openclawVersion}\nteamclaw@${teamclawVersion}\n`, "utf8");
const plat = process.platform + "-" + process.arch;
const tar = `teamclaw-runtime-${plat}.tar.gz`;
const tarPath = path.join(outDir, tar);
execSync(`tar czf ${JSON.stringify(tarPath)} -C ${outDir} runtime`, { stdio: "inherit" });
// Portable sha256 (node crypto): `shasum` does not exist on stock Windows.
const sha256 = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(`${tarPath}.sha256`, `${sha256}  ${tar}\n`, "utf8");
console.log(`[runtime-tar] ${tar} ready (+.sha256)`);
