// W1 of issue #226 (worker-provisioning god-file split): managed-name
// construction and the container bootstrap script shared by the docker and
// kubernetes backends, extracted VERBATIM from controller/worker-provisioning.ts.
// The generic string sanitizers now live in shared/utils.ts.
import { createHash } from "node:crypto";
import type { RoleId } from "../../types.js";
import { sanitizePathSegment, sanitizeName } from "../../shared/utils.js";

export function buildManagedInstanceName(teamName: string, role: RoleId, workerId: string): string {
  return buildManagedName("teamclaw", teamName, role, workerId, {
    teamBudget: 18,
    roleBudget: 12,
    workerBudget: 12,
    hashLength: 8,
    maxLength: 63,
  });
}

export function buildManagedHostname(teamName: string, role: RoleId, workerId: string): string {
  return buildManagedName("tc", teamName, role, workerId, {
    teamBudget: 10,
    roleBudget: 8,
    workerBudget: 6,
    hashLength: 6,
    maxLength: 40,
  });
}

function buildManagedName(
  prefix: string,
  teamName: string,
  role: RoleId,
  workerId: string,
  options: {
    teamBudget: number;
    roleBudget: number;
    workerBudget: number;
    hashLength: number;
    maxLength: number;
  },
): string {
  const teamPart = sanitizeLeadingSegment(teamName, options.teamBudget, "team");
  const rolePart = sanitizeLeadingSegment(role, options.roleBudget, "worker");
  const workerPart = sanitizeTrailingSegment(workerId, options.workerBudget, "worker");
  const hash = shortStableHash(`${teamName}:${role}:${workerId}`).slice(0, options.hashLength);
  return sanitizeName(`${prefix}-${teamPart}-${rolePart}-${workerPart}-${hash}`, options.maxLength);
}

function shortStableHash(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function sanitizeLeadingSegment(value: string, maxLength: number, fallback: string): string {
  const normalized = sanitizePathSegment(value).slice(0, maxLength).replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function sanitizeTrailingSegment(value: string, maxLength: number, fallback: string): string {
  const normalized = sanitizePathSegment(value).slice(-maxLength).replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function buildContainerBootstrapScript(rateLimitMaxRetries: number): string {
  return [
    "set -eu",
    "mkdir -p \"$OPENCLAW_STATE_DIR\"",
    "if [ -n \"${TEAMCLAW_WORKSPACE_DIR:-}\" ]; then mkdir -p \"$TEAMCLAW_WORKSPACE_DIR\"; fi",
    // Issue #237 W4: the bootstrap config carries provider API keys - write
    // it owner-only inside the container too (the old permissionless call
    // defaulted to 0644). The remaining exposure is the env injection
    // itself (TEAMCLAW_BOOTSTRAP_CONFIG_B64 is visible to `docker inspect`
    // and pod-env readers); migrating the docker/kubernetes backends to
    // mounted Secrets needs a coordinated chart/image change (cf. #230's
    // image-skew caveat) and is tracked by #237 W4.
    // Review follow-up (#237): { mode } is creation-only, so rewriting a
    // pre-existing 0644 config (baked into an older image or surviving on
    // a mounted volume) would keep the loose mode - chmodSync the existing
    // file first, tolerating ENOENT for first writes (then { mode: 0o600 }
    // creates it owner-only). Chosen over unlink-then-write to avoid the
    // no-config window mid-rewrite.
    "node -e 'const fs=require(\"fs\"); const configPath=process.env.OPENCLAW_CONFIG_PATH; const raw=Buffer.from(process.env.TEAMCLAW_BOOTSTRAP_CONFIG_B64||\"\", \"base64\").toString(\"utf8\"); fs.mkdirSync(require(\"path\").dirname(configPath), { recursive: true }); try { fs.chmodSync(configPath, 0o600); } catch (err) { if (err.code !== \"ENOENT\") throw err; } fs.writeFileSync(configPath, raw, { mode: 0o600 });'",
    // #rate-limit-999: same worker retry override as the process backend,
    // written beside the config (settings.json global scope). The value is
    // baked in by the caller from the same plugin config every backend reads.
    `node -e 'const fs=require("fs"); const p=require("path"); const sp=p.join(p.dirname(process.env.OPENCLAW_CONFIG_PATH), "settings.json"); fs.writeFileSync(sp, JSON.stringify({retry:{enabled:true,provider:{maxRetries:${rateLimitMaxRetries}}}}, null, 2)+"\\n", { mode: 0o600 });'`,
    "exec node dist/index.js gateway --allow-unconfigured",
  ].join("\n");
}
