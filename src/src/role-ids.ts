import type { RoleId } from "./types.js";

/**
 * Canonical ordered TeamClaw role id list (Phase 1.2 single-source
 * convergence, vertical-team-profiles-design.md section 1.1).
 *
 * This module is deliberately dependency-free (type-only import) so it can be
 * imported from anywhere - including prompt-policy.ts and
 * openclaw-workspace.ts, which sit BELOW roles.ts in the module graph and
 * therefore cannot value-import roles.ts without creating a cycle
 * (roles.ts -> prompt-policy.ts -> openclaw-workspace.ts at runtime).
 *
 * roles.ts keeps ROLE_IDS derived from its ROLES registry and asserts at
 * module init that both lists agree, so this file and the registry can never
 * silently drift apart. The manifest generator
 * (scripts/sync-teamclaw-plugin-manifest.mjs) extracts this array from the
 * source text so openclaw.plugin.json derives from the same list.
 */
export const ROLE_IDS: RoleId[] = [
  "pm",
  "architect",
  "developer",
  "qa",
  "release-engineer",
  "infra-engineer",
  "devops",
  "security-engineer",
  "designer",
  "marketing",
  "data-engineer",
];
