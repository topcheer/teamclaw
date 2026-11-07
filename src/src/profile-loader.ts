import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleDefinition, RoleId } from "./types.js";

/**
 * TeamProfile loader (Phase 1.3, vertical-team-profiles-design.md sections
 * 2.1/2.2).
 *
 * The built-in profiles live as JSON next to this module (src/src/profiles/
 * in the source tree, dist/src/profiles/ in the built package) and are read
 * + schema-validated once at module init, mirroring the roles.ts registry
 * init guard: a profile that fails validation is FATAL (throw, refuse to
 * start) per design section 2.2 - a corrupt profile must never silently
 * degrade one industry into another. The only sanctioned fallback is the
 * "configured profile id does not exist" case (first initialization), which
 * the controller resolves to software-rd with a warning before calling
 * setActiveProfileId (see controller-service.ts).
 *
 * This module is deliberately dependency-free at runtime (type-only import
 * of types.js) so config.ts and any other early module can consume the
 * active profile without import cycles. roles.ts and role-ids.ts remain the
 * type/drift-guard layer and the generator source; the runtime consumption
 * face for the Phase 1.3 switch is this loader's output.
 */

export type TeamProfileCapabilities = {
  git: boolean;
  teamauto: boolean;
  runnablePreview: boolean;
  deliveryReview: boolean;
};

export type TeamProfileOutputConstraints = {
  tailnote?: string;
  refusals?: string[];
  citationPolicy?: Record<string, unknown>;
};

export type TeamProfile = {
  /** Profile schema format version (additive-only evolution, design 2.2). */
  schemaVersion: number;
  id: string;
  name: string;
  nameZh: string;
  industry: string;
  icon: string;
  version: string;
  reviewedBy?: string[];
  description: string;
  params?: Record<string, unknown>;
  roles: RoleDefinition[];
  domainInstructions?: string[];
  outputConstraints?: TeamProfileOutputConstraints;
  glossary?: string[];
  workflows?: Array<Record<string, unknown>>;
  capabilities: TeamProfileCapabilities;
  warmupRoles: RoleId[];
  knowledgePacks?: string[];
  deliverableHints?: Record<string, unknown>;
  defaultRole: RoleId;
};

// ---------------------------------------------------------------------------
// JSON Schema (subset) validation.
//
// schema.json is a plain JSON file, so it cannot carry TypeBox Kind symbols
// and @sinclair/typebox/value rejects serialized schemas (verified: throws
// ValueCheckUnknownTypeError). Instead of adding a JSON Schema dependency to
// the runtime, this interpreter supports exactly the keyword subset
// schema.json uses. assertSchemaUsesSupportedKeywords() runs at init against
// the loaded schema itself, so schema.json can never silently use a keyword
// the interpreter would ignore.
// ---------------------------------------------------------------------------

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "uniqueItems",
  "minLength",
  "pattern",
]);

const SUPPORTED_SCHEMA_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

type JsonSchema = Record<string, unknown>;

function isSchemaObject(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSchemaUsesSupportedKeywords(schema: unknown, at: string): void {
  if (!isSchemaObject(schema)) {
    throw new Error(`profiles schema ${at}: every subschema must be an object`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(
        `profiles schema ${at}: keyword "${keyword}" is not supported by the profile-loader validator `
          + `(supported: ${[...SUPPORTED_SCHEMA_KEYWORDS].sort().join(", ")}); extend both together`,
      );
    }
  }
  if (schema.type !== undefined) {
    const type = schema.type;
    if (typeof type !== "string" || !SUPPORTED_SCHEMA_TYPES.has(type)) {
      throw new Error(`profiles schema ${at}: unsupported "type" value ${JSON.stringify(type)}`);
    }
  }
  // Keyword FORM guards (review fix): the checker below only interprets a
  // narrow form of each keyword; any other form (e.g. additionalProperties
  // as a permissive subschema, non-string pattern, non-string required
  // entries, non-number length/item bounds) would otherwise be SILENTLY
  // ignored and the schema would validate less than it appears to.
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(
      `profiles schema ${at}: "additionalProperties" is only supported as the literal false `
        + `(permissive-subschema form is not implemented); found ${JSON.stringify(schema.additionalProperties)}`,
    );
  }
  if (schema.pattern !== undefined && typeof schema.pattern !== "string") {
    throw new Error(`profiles schema ${at}: "pattern" must be a string`);
  }
  if (
    schema.required !== undefined
    && (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== "string"))
  ) {
    throw new Error(`profiles schema ${at}: "required" must be an array of strings`);
  }
  if (schema.minLength !== undefined && typeof schema.minLength !== "number") {
    throw new Error(`profiles schema ${at}: "minLength" must be a number`);
  }
  if (schema.minItems !== undefined && typeof schema.minItems !== "number") {
    throw new Error(`profiles schema ${at}: "minItems" must be a number`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    throw new Error(`profiles schema ${at}: "uniqueItems" must be a boolean`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new Error(`profiles schema ${at}: "enum" must be an array`);
  }
  if (schema.properties !== undefined) {
    if (!isSchemaObject(schema.properties)) {
      throw new Error(`profiles schema ${at}: "properties" must be an object`);
    }
    for (const [key, subschema] of Object.entries(schema.properties)) {
      assertSchemaUsesSupportedKeywords(subschema, `${at}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) {
    assertSchemaUsesSupportedKeywords(schema.items, `${at}.items`);
  }
}

function checkTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isSchemaObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function collectSchemaErrors(value: unknown, schema: JsonSchema, at: string, errors: string[]): void {
  if (schema.type !== undefined && !checkTypeMatches(schema.type as string, value)) {
    errors.push(`${at}: expected ${JSON.stringify(schema.type)}, got ${Array.isArray(value) ? "array" : typeof value}`);
    return;
  }
  if (schema.enum !== undefined) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
      errors.push(`${at}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
      return;
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${at}: string is shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: string does not match pattern ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${at}: array has fewer than minItems ${schema.minItems} (${value.length})`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((entry) => JSON.stringify(entry)));
      if (seen.size !== value.length) {
        errors.push(`${at}: array items are not unique`);
      }
    }
    if (isSchemaObject(schema.items)) {
      value.forEach((entry, index) => collectSchemaErrors(entry, schema.items as JsonSchema, `${at}[${index}]`, errors));
    }
  }
  if (isSchemaObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) {
          errors.push(`${at}: missing required property "${key}"`);
        }
      }
    }
    const properties = isSchemaObject(schema.properties) ? schema.properties as Record<string, JsonSchema> : {};
    for (const [key, subschema] of Object.entries(properties)) {
      if (key in value) {
        collectSchemaErrors(value[key], subschema, `${at}.${key}`, errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${at}: unexpected property "${key}" (additionalProperties is false)`);
        }
      }
    }
  }
}

function validateProfileAgainstSchema(profile: unknown, schema: JsonSchema, profileFile: string): void {
  const errors: string[] = [];
  collectSchemaErrors(profile, schema, "$", errors);
  if (errors.length > 0) {
    throw new Error(
      `TeamClaw profile "${profileFile}" failed schema validation (design 2.2 - refusing to start):\n`
        + errors.map((line) => `  - ${line}`).join("\n"),
    );
  }
}

/**
 * Validate one profile package against one schema document with the full
 * loader pipeline (JSON Schema subset + supported schemaVersion + cross-field
 * role-reference checks). Exported for the Phase 1.7 loader unit tests and
 * for future profile-authoring tooling; the built-in load path calls it for
 * every packaged profile at module init.
 */
function validateProfilePackage(profile: unknown, schema: unknown, profileFile: string): TeamProfile {
  assertSchemaUsesSupportedKeywords(schema, "schema.json");
  validateProfileAgainstSchema(profile, schema as JsonSchema, profileFile);
  const record = profile as TeamProfile;
  if (record.schemaVersion !== SUPPORTED_PROFILE_SCHEMA_VERSION) {
    // Reserved evolution hook (design 2.2, additive-only): a future format
    // version is a hard stop for this build, never a silent skip.
    throw new Error(
      `TeamClaw profile ${profileFile} declares schemaVersion ${JSON.stringify(record.schemaVersion)}, `
        + `but this build supports only ${SUPPORTED_PROFILE_SCHEMA_VERSION}. Update TeamClaw.`,
    );
  }
  crossValidateProfile(record, profileFile);
  return record;
}

// ---------------------------------------------------------------------------
// Load + validate the built-in profiles once, at module init.
// ---------------------------------------------------------------------------

const SUPPORTED_PROFILE_SCHEMA_VERSION = 1;
const SOFTWARE_RD_PROFILE_ID = "software-rd";
const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "profiles");

function readJsonFile(filePath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `TeamClaw cannot read required file ${filePath} (${error instanceof Error ? error.message : String(error)}). `
        + "Built-in profiles ship with the package; in a dev checkout run `npm --prefix src run build` first.",
    );
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`TeamClaw profile file ${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadBuiltinProfiles(): Map<string, TeamProfile> {
  const schemaFilePath = path.join(PROFILES_DIR, "schema.json");
  const schema = readJsonFile(schemaFilePath) as JsonSchema;
  assertSchemaUsesSupportedKeywords(schema, "schema.json");

  let profileFiles: string[];
  try {
    profileFiles = fs.readdirSync(PROFILES_DIR)
      .filter((name) => name.endsWith(".json") && name !== "schema.json")
      .sort();
  } catch (error) {
    throw new Error(
      `TeamClaw cannot read the built-in profiles directory ${PROFILES_DIR} `
        + `(${error instanceof Error ? error.message : String(error)}); run \`npm --prefix src run build\` in a dev checkout.`,
    );
  }
  if (profileFiles.length === 0) {
    throw new Error(`TeamClaw built-in profiles directory ${PROFILES_DIR} contains no profile packages`);
  }

  const profiles = new Map<string, TeamProfile>();
  for (const file of profileFiles) {
    const profile = readJsonFile(path.join(PROFILES_DIR, file));
    const record = validateProfilePackage(profile, schema, file);
    profiles.set(record.id, record);
  }
  if (!profiles.has(SOFTWARE_RD_PROFILE_ID)) {
    throw new Error(
      `TeamClaw built-in profiles are missing the "${SOFTWARE_RD_PROFILE_ID}" baseline package `
        + `(it is the fallback profile for unconfigured first initialization)`,
    );
  }
  return profiles;
}

/** Structural checks that sit outside what the JSON Schema subset can express. */
function crossValidateProfile(profile: TeamProfile, profileFile: string): void {
  const roleIds = profile.roles.map((role) => role.id);
  const roleIdSet = new Set(roleIds);
  if (roleIdSet.size !== roleIds.length) {
    throw new Error(`TeamClaw profile ${profileFile} ("${profile.id}") has duplicate role ids`);
  }
  const referenceErrors: string[] = [];
  if (!roleIdSet.has(profile.defaultRole)) {
    referenceErrors.push(`defaultRole "${profile.defaultRole}" is not a role of this profile`);
  }
  for (const roleId of profile.warmupRoles) {
    if (!roleIdSet.has(roleId)) {
      referenceErrors.push(`warmupRoles entry "${roleId}" is not a role of this profile`);
    }
  }
  for (const role of profile.roles) {
    for (const nextRoleId of role.suggestedNextRoles) {
      if (!roleIdSet.has(nextRoleId)) {
        referenceErrors.push(`role "${role.id}" suggestedNextRoles entry "${nextRoleId}" is not a role of this profile`);
      }
    }
  }
  if (referenceErrors.length > 0) {
    throw new Error(
      `TeamClaw profile ${profileFile} ("${profile.id}") has dangling role references (design 2.2 - refusing to start):\n`
        + referenceErrors.map((line) => `  - ${line}`).join("\n"),
    );
  }
}

const BUILTIN_PROFILES = loadBuiltinProfiles();

// ---------------------------------------------------------------------------
// Phase 2.1 test-hook: optional extra profile packages (additive merge).
//
// TEAMCLAW_EXTRA_PROFILES_DIR points at a directory (e.g. the repository's
// tests/fixtures/profiles/) whose *.json packages are validated with the same
// schema + cross-field pipeline and MERGED into the built-in registry. This
// lets integration tests exercise the switch/archive/capability paths against
// a minimal non-software profile WITHOUT shipping test fixtures inside
// src/profiles/ (design 2.2: that directory is the distributed package set).
// The env var is unset in production, so runtime behavior is bit-identical;
// a broken extra package stays FATAL (same loader red line).
// ---------------------------------------------------------------------------

const EXTRA_PROFILES_DIR = process.env.TEAMCLAW_EXTRA_PROFILES_DIR?.trim() ?? "";

function mergeExtraProfiles(): void {
  let files: string[];
  try {
    files = fs.readdirSync(EXTRA_PROFILES_DIR)
      .filter((name) => name.endsWith(".json") && name !== "schema.json")
      .sort();
  } catch {
    throw new Error(
      `TeamClaw cannot read TEAMCLAW_EXTRA_PROFILES_DIR "${EXTRA_PROFILES_DIR}" `
        + "(set it to a directory of TeamProfile JSON packages, or unset it).",
    );
  }
  const schemaFilePath = path.join(PROFILES_DIR, "schema.json");
  const schema = readJsonFile(schemaFilePath) as JsonSchema;
  for (const file of files) {
    const record = validateProfilePackage(readJsonFile(path.join(EXTRA_PROFILES_DIR, file)), schema, file);
    if (BUILTIN_PROFILES.has(record.id)) {
      throw new Error(`TeamClaw extra profile ${file} shadows the built-in profile id "${record.id}"`);
    }
    BUILTIN_PROFILES.set(record.id, record);
  }
}

if (EXTRA_PROFILES_DIR) {
  mergeExtraProfiles();
}

// The active profile defaults to the software-rd baseline. In controller
// mode, controller-service re-points it from TeamState.profileId (the single
// runtime truth, design 2.3) after loading state; config teamProfile only
// seeds FIRST initialization. Worker mode follows the controller (v1).
let activeProfileId: string = SOFTWARE_RD_PROFILE_ID;

/** True when `id` names a built-in profile package. */
function hasProfile(id: string): boolean {
  return BUILTIN_PROFILES.has(id);
}

/** Switch the active profile. Unknown ids are a programming error (throw). */
function setActiveProfileId(id: string): void {
  if (!BUILTIN_PROFILES.has(id)) {
    throw new Error(`TeamClaw profile "${id}" is not a built-in profile (available: ${[...BUILTIN_PROFILES.keys()].sort().join(", ")})`);
  }
  activeProfileId = id;
}

function getActiveProfileId(): string {
  return activeProfileId;
}

function getActiveProfile(): TeamProfile {
  const profile = BUILTIN_PROFILES.get(activeProfileId);
  if (!profile) {
    throw new Error(`TeamClaw active profile "${activeProfileId}" disappeared from the built-in registry`);
  }
  return profile;
}

function getActiveRoles(): RoleDefinition[] {
  return getActiveProfile().roles;
}

function getActiveRoleIds(): RoleId[] {
  return getActiveRoles().map((role) => role.id);
}

function getActiveDefaultRole(): RoleId {
  return getActiveProfile().defaultRole;
}

/** Active-profile counterpart of roles.ts getRole. */
function getActiveRole(id: RoleId): RoleDefinition | undefined {
  return getActiveRoles().find((role) => role.id === id);
}

/**
 * Active-profile counterpart of roles.ts validateRoleId: returns the trimmed
 * role id when `raw` is a string naming a role of the active profile,
 * otherwise undefined. Never throws.
 */
function validateActiveRoleId(raw: unknown): RoleId | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  return getActiveRole(raw.trim() as RoleId)?.id;
}

/**
 * Same normalization semantics as the roles.ts registry helper (trim, drop
 * blanks, dedupe case-insensitively keeping first occurrence and original
 * casing). Lives here because the runtime consumers (http-server endpoints,
 * worker skill-installer) moved to the profile face in Phase 1.3; roles.ts
 * keeps its own copy for the registry layer. Behavior is locked byte-for-byte
 * by tests/test-software-rd-golden.mjs.
 */
function normalizeRecommendedSkills(skills: string[] = []): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of skills) {
    const value = String(entry || "").trim();
    if (!value) {
      continue;
    }
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(value);
  }
  return normalized;
}

/** Active-profile counterpart of roles.ts resolveRecommendedSkillsForRole. */
function resolveActiveRoleSkills(roleId?: RoleId, taskSkills: string[] = []): string[] {
  const roleSkills = roleId ? (getActiveRole(roleId)?.recommendedSkills ?? []) : [];
  return normalizeRecommendedSkills([...roleSkills, ...taskSkills]);
}

export {
  BUILTIN_PROFILES,
  SOFTWARE_RD_PROFILE_ID,
  validateProfilePackage,
  hasProfile,
  setActiveProfileId,
  getActiveProfileId,
  getActiveProfile,
  getActiveRoles,
  getActiveRoleIds,
  getActiveDefaultRole,
  getActiveRole,
  validateActiveRoleId,
  normalizeRecommendedSkills,
  resolveActiveRoleSkills,
};
