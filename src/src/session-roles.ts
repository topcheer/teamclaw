/**
 * Session-role string normalization, shared by the controller http-server and
 * the worker task executor (single source since issue #204's dedupe finding).
 */
export function normalizeSessionRole(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (normalized === "toolresult") {
    return "tool_result";
  }
  return normalized;
}
