// W1 of issue #226 (worker-provisioning god-file split): TeamClaw plugin
// root resolution, extracted VERBATIM from controller/worker-provisioning.ts.
// The ONLY non-verbatim byte in this file: resolveCurrentTeamClawPluginRootDir
// walks "../../../" instead of "../../" because this module sits one level
// deeper (controller/provisioning/); the RESOLVED directory (the plugin
// package root, in source and dist layouts alike) is unchanged.
// Shared by the process backend (runtime extensions symlink) and the docker
// backend (bundled-plugin bind). Never imports worker-provisioning.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveCurrentTeamClawPluginRootDir(): string {
  return process.env.TEAMCLAW_BAKED_IN === "true" ? "" : path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

/**
 * Locate the teamclaw plugin root inside a baked runtime image. The image
 * ships the plugin at <app-root>/extensions/teamclaw; the controller
 * entrypoint (process.argv[1]) lives under <app-root>, so walk up from it.
 * Returns "" when no candidate carries an openclaw.plugin.json (the
 * caller then skips the symlink instead of creating a dangling one).
 */
export async function resolveBakedTeamClawPluginRootDir(): Promise<string> {
  const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const candidates = entrypoint
    ? [
        path.resolve(entrypoint, "../../extensions/teamclaw"),
        path.resolve(entrypoint, "../extensions/teamclaw"),
      ]
    : [];
  candidates.push("/app/extensions/teamclaw");
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "openclaw.plugin.json"));
      return candidate;
    } catch {
      // try the next candidate layout
    }
  }
  return "";
}
