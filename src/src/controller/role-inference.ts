// Phase 1.3: inference candidates come from the active TeamProfile.
import { getActiveRoles } from "../profile-loader.js";
import type { ProfileRoleDefinition } from "../profile-loader.js";
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
// A token made purely of ASCII letters/digits (all tokens the pattern above
// extracts). Such tokens match as STANDALONE WORDS, never as substrings of a
// longer ASCII word: "data" must not hit "database", "test" must not hit
// "testing", "pm" must not hit "npm". Multi-word phrases ("software
// architect") and CJK runs keep whole-phrase containment semantics.
const ASCII_WORD_TOKEN_PATTERN = /^[a-z0-9]+$/;
// CJK Unified Ideographs, Extension A, and CJK Compatibility Ideographs.
const CJK_RUN_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

// ---------------------------------------------------------------------------
// Phase 2.5 tiered scoring (vertical-team-profiles-design.md section 2.3).
//
// Token hits are weighted by their SOURCE tier:
//   labelZh full phrase  >  label full phrase  >  id/label word  >  capability word
// ("labelZh 完整词 > 高区分度业务词 > 泛化词"). Weights are integers so the
// fallback margin below is measured in whole tiers or whole token hits.
// ---------------------------------------------------------------------------
const WEIGHT_LABELZH_PHRASE = 8;
const WEIGHT_LABEL_PHRASE = 6;
const WEIGHT_ID_LABEL_WORD = 3;
const WEIGHT_CAPABILITY_WORD = 1;

/**
 * Rarity stopword threshold (design 2.3): a token that appears in MORE THAN
 * one third of the active profile's roles discriminates nothing
 * ("分析/管理/合规 全员命中等于没命中") and is dropped from scoring entirely.
 * Computed per inference call over the active role set, so a token that is
 * generic in one profile (合规 in banking) can stay distinctive in another.
 */
const RARITY_STOPWORD_FRACTION = 1 / 3;

/**
 * LLM-fallback margin (design 2.3): the token fast path is confident only
 * when the runner-up scores strictly below the winner by at least this much.
 * Any tie (margin < 1) escalates to the LLM fallback instead of the old
 * "并列取数组靠前" registry-order determinism. The value is 1 - not higher -
 * because the design's own high-distinctiveness examples (反洗钱→aml-analyst,
 * 贷审→approver) are single capability-tier hits with margin exactly 1 and
 * must stay on the fast path.
 */
const LLM_FALLBACK_SCORE_MARGIN = 1;

function isAsciiAlphanumeric(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  return (char >= "0" && char <= "9") || (char >= "a" && char <= "z");
}

/**
 * Check whether a pure-ASCII word token occurs in `text` as a standalone
 * word rather than inside a longer ASCII word. Plain substring containment
 * would misroute texts like "npm install fails" to the "pm" role, "build a
 * guide page" to the "ui" role, or (Phase 2.5 regression found in testing)
 * "Design the database schema" to the data-engineer role via "data" inside
 * "database". Non-ASCII neighbours (CJK characters, punctuation, string
 * boundaries, hyphens in kebab ids) still count as boundaries, so "qa"
 * matches inside "处理QA登录问题" after lowercasing.
 */
function asciiWordTokenInText(token: string, text: string): boolean {
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
  if (ASCII_WORD_TOKEN_PATTERN.test(token)) {
    return asciiWordTokenInText(token, text);
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
 *   produce crossing-window false positives.
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

/** Scoring units of one role: token/phrase -> its highest source-tier weight. */
function buildRoleScoringUnits(role: ProfileRoleDefinition): Map<string, number> {
  const units = new Map<string, number>();
  const put = (token: string, weight: number): void => {
    const current = units.get(token);
    if (current === undefined || weight > current) {
      units.set(token, weight);
    }
  };

  const labelZh = typeof role.labelZh === "string" ? role.labelZh.trim().toLowerCase() : "";
  if (labelZh) {
    put(labelZh, WEIGHT_LABELZH_PHRASE);
    for (const token of extractRoleTokens(labelZh)) {
      put(token, WEIGHT_ID_LABEL_WORD);
    }
  }
  const label = role.label.trim().toLowerCase();
  if (label) {
    put(label, WEIGHT_LABEL_PHRASE);
  }
  for (const entry of [role.id, role.label]) {
    for (const token of extractRoleTokens(entry)) {
      put(token, WEIGHT_ID_LABEL_WORD);
    }
  }
  for (const capability of role.capabilities) {
    for (const token of extractRoleTokens(capability)) {
      put(token, WEIGHT_CAPABILITY_WORD);
    }
  }
  return units;
}

export type RoleInferenceVerdict = {
  /** Fast-path winner; null when nothing scored or the verdict escalated. */
  role: RoleId | null;
  runnerUp: RoleId | null;
  topScore: number;
  runnerUpScore: number;
  topScoreMinusRunnerUp: number;
  /** True when the token fast path refuses to decide (design 2.3 LLM fallback). */
  needsLlmFallback: boolean;
  reason: "assigned" | "confident" | "all-zero" | "tie";
};

/**
 * Rank the active profile's roles against the task text with tiered,
 * rarity-adjusted token scoring and report the confidence verdict.
 *
 * Pure function: no LLM calls. Callers that need a decision when
 * `needsLlmFallback` is true own the fallback (see
 * resolveTaskRoleWithLlmFallback in kickoff-orchestrator.ts).
 */
export function inferTaskRoleWithConfidence(
  task: Pick<TaskInfo, "assignedRole" | "title" | "description">,
): RoleInferenceVerdict {
  if (task.assignedRole) {
    return {
      role: task.assignedRole,
      runnerUp: null,
      topScore: 0,
      runnerUpScore: 0,
      topScoreMinusRunnerUp: 0,
      needsLlmFallback: false,
      reason: "assigned",
    };
  }

  const roles = getActiveRoles();
  const text = `${task.title} ${task.description}`.toLowerCase();
  const unitMaps = roles.map((role) => buildRoleScoringUnits(role));

  // Rarity stopwords over the active profile's role set: token -> number of
  // roles carrying it at any tier.
  const documentFrequency = new Map<string, number>();
  for (const units of unitMaps) {
    for (const token of units.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const stopwordCount = roles.length * RARITY_STOPWORD_FRACTION;
  const isStopword = (token: string): boolean => (documentFrequency.get(token) ?? 0) > stopwordCount;

  let bestRole: RoleId | null = null;
  let bestScore = 0;
  let runnerUpRole: RoleId | null = null;
  let runnerUpScore = 0;
  roles.forEach((role, index) => {
    let score = 0;
    for (const [token, weight] of unitMaps[index]!) {
      if (isStopword(token)) {
        continue;
      }
      if (tokenInText(token, text)) {
        score += weight;
      }
    }
    if (score > bestScore) {
      runnerUpRole = bestRole;
      runnerUpScore = bestScore;
      bestRole = role.id;
      bestScore = score;
    } else if (score > runnerUpScore) {
      runnerUpRole = role.id;
      runnerUpScore = score;
    }
  });

  if (bestScore <= 0) {
    return {
      role: null,
      runnerUp: null,
      topScore: 0,
      runnerUpScore: 0,
      topScoreMinusRunnerUp: 0,
      needsLlmFallback: true,
      reason: "all-zero",
    };
  }
  const margin = bestScore - runnerUpScore;
  if (margin < LLM_FALLBACK_SCORE_MARGIN) {
    return {
      role: bestRole,
      runnerUp: runnerUpRole,
      topScore: bestScore,
      runnerUpScore,
      topScoreMinusRunnerUp: margin,
      needsLlmFallback: true,
      reason: "tie",
    };
  }
  return {
    role: bestRole,
    runnerUp: runnerUpRole,
    topScore: bestScore,
    runnerUpScore,
    topScoreMinusRunnerUp: margin,
    needsLlmFallback: false,
    reason: "confident",
  };
}

/**
 * Infer the most appropriate role for a task based on text analysis.
 *
 * If `task.assignedRole` is already set, returns it directly. Otherwise the
 * tiered token fast path decides only when it is confident (design 2.3): a
 * tie between the top two roles - the old "并列取数组靠前" registry-order
 * determinism - or an all-zero scoreboard returns `null` so the caller can
 * escalate to the controller LLM fallback (or its own default role).
 */
export function inferTaskRole(task: Pick<TaskInfo, "assignedRole" | "title" | "description">): RoleId | null {
  const verdict = inferTaskRoleWithConfidence(task);
  return verdict.needsLlmFallback ? null : verdict.role;
}
