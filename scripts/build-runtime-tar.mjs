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
// #release-race (same family as desktop prepare-bundle): this workflow fires
// on the release tag in parallel with the npm publish - the version may not
// be on the registry yet (v2026.11.4: ETARGET 8s before the publish job
// finished). Poll availability, retry with backoff; file: specs skip waiting.
const npmInstall = () => execSync(`npm install --prefix ${path.join(outDir, "runtime")} openclaw@${openclawVersion} ${JSON.stringify(teamclawSpec)}`, { stdio: "inherit" });
if (teamclawSpec.startsWith("file:")) {
  npmInstall();
} else {
  const pkgAvailable = (spec) => {
    try {
      execSync(`npm view ${spec} version --silent`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + Number(process.env.RUNTIME_STAGE_WAIT_MS || 45 * 60_000);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      if (!pkgAvailable(teamclawSpec)) {
        throw new Error(`package not visible on the registry yet: ${teamclawSpec}`);
      }
      npmInstall();
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        console.error(`[runtime-tar] giving up after ${attempt} attempts: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(attempt, 4));
      console.log(`[runtime-tar] attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${Math.round(backoff / 1000)}s`);
      execSync(`sleep ${Math.round(backoff / 1000)}`, { stdio: "ignore" });
    }
  }
}
writeFileSync(path.join(outDir, "runtime", "RUNTIME-VERSION"), `openclaw@${openclawVersion}\nteamclaw@${teamclawVersion}\n`, "utf8");
const plat = process.platform + "-" + process.arch;
const tar = `teamclaw-runtime-${plat}.tar.gz`;
const tarPath = path.join(outDir, tar);
execSync(`tar czf ${JSON.stringify(tarPath)} -C ${outDir} runtime`, { stdio: "inherit" });
// Portable sha256 (node crypto): `shasum` does not exist on stock Windows.
const sha256 = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
writeFileSync(`${tarPath}.sha256`, `${sha256}  ${tar}\n`, "utf8");
console.log(`[runtime-tar] ${tar} ready (+.sha256)`);
