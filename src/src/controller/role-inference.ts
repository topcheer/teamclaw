// Phase 1.3: inference candidates come from the active TeamProfile.
import { getActiveRoles } from "../profile-loader.js";
import type { RoleId, TaskInfo } from "../types.js";

/**
 * Minimum length for ASCII (latin letter / digit) tokens. Two-character
 * tokens such as "qa", "pm", "ci", "ui" are meaningful role identifiers and
 * must participate in scoring. The previous `length > 2` filter dropped them.
 */
const ASCII_TOKEN_MIN_LENGTH = 2;

/**
 * Minimum length for CJK run tokens, in characters. Single CJK characters
 * are too ambiguous to score on; runs of two or more characters are kept.
 */
const CJK_TOKEN_MIN_LENGTH = 2;

const ASCII_TOKEN_PATTERN = /[a-z0-9]+/g;
// CJK Unified Ideographs, Extension A, and CJK Compatibility Ideographs.
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

function isAsciiAlphanumeric(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  return (char >= "0" && char <= "9") || (char >= "a" && char <= "z");
}

/**
 * Check whether a two-character ASCII token occurs in `text` as a standalone
 * token rather than inside a longer ASCII run. Plain substring containment
 * would misroute texts like "npm install fails" to the "pm" role or "build a
 * guide page" to the "ui" role. Non-ASCII neighbours (CJK characters,
 * punctuation, string boundaries) still count as boundaries, so "qa" matches
 * inside "处理QA登录问题" after lowercasing.
 */
function shortAsciiTokenInText(token: string, text: string): boolean {
  let index = text.indexOf(token);
  while (index !== -1) {
    const boundedBefore = !isAsciiAlphanumeric(text[index - 1]);
    const boundedAfter = !isAsciiAlphanumeric(text[index + token.length]);
    if (boundedBefore && boundedAfter) {
      return true;
    }
    index = text.indexOf(token, index + 1);
  }
  return false;
}

function tokenInText(token: string, text: string): boolean {
  if (token.length === ASCII_TOKEN_MIN_LENGTH && isAsciiAlphanumeric(token.charAt(0))) {
    return shortAsciiTokenInText(token, text);
  }
  return text.includes(token);
}

/**
 * Extract scoring tokens from one role-facing string (id, label, capability).
 *
 * Two kinds of tokens are produced:
 * - ASCII alphanumeric runs of at least 2 characters ("qa", "deployment").
 * - Contiguous CJK runs of at least 2 characters ("核保", "架构设计"), kept
 *   whole: `text.includes(token)` then has exact-phrase semantics and cannot
 *   produce crossing-window false positives. Weighted / stopword CJK scoring
 *   is deliberately out of scope here (P2.5). The current role registry is
 *   English-only, so CJK runs yield no tokens today; the extraction exists so
 *   bilingual role labels can plug in without touching this module again.
 */
export function extractRoleTokens(entry: string): string[] {
  const lowered = entry.toLowerCase();
  const tokens: string[] = [];
  for (const match of lowered.matchAll(ASCII_TOKEN_PATTERN)) {
    if (match[0].length >= ASCII_TOKEN_MIN_LENGTH) {
      tokens.push(match[0]);
    }
  }
  for (const match of lowered.matchAll(CJK_RUN_PATTERN)) {
    if (match[0].length >= CJK_TOKEN_MIN_LENGTH) {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

/**
 * Infer the most appropriate role for a task based on text analysis.
 *
 * If `task.assignedRole` is already set, returns it directly.
 * Otherwise, tokenizes the task title + description and scores each known
 * role by overlap with its id, label, and capabilities. Ties keep the role
 * that comes first in the registry order. Returns `null` when nothing scores
 * above zero; callers apply their own fallback (see `DEFAULT_ROLE`).
 */
export function inferTaskRole(task: Pick<TaskInfo, "assignedRole" | "title" | "description">): RoleId | null {
  if (task.assignedRole) {
    return task.assignedRole;
  }

  const text = `${task.title} ${task.description}`.toLowerCase();
  let bestRole: RoleId | null = null;
  let bestScore = 0;

  for (const role of getActiveRoles()) {
    const roleTokens = [
      role.id,
      role.label,
      ...role.capabilities,
    ].flatMap((entry) => extractRoleTokens(entry));
    const uniqueTokens = [...new Set(roleTokens)];
    const score = uniqueTokens.reduce((count, token) => count + (tokenInText(token, text) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestRole = role.id;
    }
  }

  return bestScore > 0 ? bestRole : null;
}
