// Shared generic utilities (issue #226 W6 dedup + W1 worker-provisioning
// split). Everything here is extracted VERBATIM from its former private
// copies - semantics are frozen, see the W6 notes per function:
//   - pathExists          strict: only ENOENT resolves false, other errors
//                          rethrow (former worker-provisioning.ts copy)
//   - pathExistsTolerant  swallowing: any access error resolves false (the
//                          former git-collaboration.ts / worker/skill-installer.ts
//                          / index.ts copies, kept as a distinct name so each
//                          call site keeps its exact original behavior)
//   - sleep / cloneJson / sanitizePathSegment / sanitizeName: single shared
//     copies of byte-identical former duplicates.
import fs from "node:fs/promises";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function pathExistsTolerant(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function sanitizePathSegment(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "worker";
}

export function sanitizeName(value: string, maxLength = 63): string {
  const normalized = sanitizePathSegment(value).slice(0, maxLength).replace(/^-+|-+$/g, "");
  return normalized || "teamclaw";
}
