/**
 * #5704 (ggcode, 2026-11-16): LLM envelope/frame leakage into GitHub write
 * surfaces. Three documented cases - a raw transport frame posted verbatim as
 * an issue comment (#5699), a write timeout with nothing landed (#5687), and
 * a PR body that was nothing but the frame JSON (#5703, PR<->issue linkage
 * survived only via title). The frame shape:
 *
 *   {"role":"assistant","content":[],"api":"openai-completions","provider":"zai",
 *    "model":"glm-5.3","usage":{...},"usageReport":{...},"contextUsage":{...}}
 *
 * reached GitHub because the reply-extraction fallback serialized the whole
 * message object as prose (fixed at the extraction site in task-executor.ts),
 * and nothing between task.result and the REST call ever asked "is this
 * intended text?". This module is the write-channel half of the fix: every
 * GitHub write body funnels through sanitizeGithubWriteBody - ordinary text
 * passes through untouched, a frame with recoverable content is repaired to
 * that content, a frame without recoverable content is rejected loudly
 * (EnvelopeLeakError) so the write-back ladder fails terminally instead of
 * retrying deterministic corruption or posting frame JSON.
 */

/** Error-message prefix the write-back ladder keys terminal classification on. */
export const ENVELOPE_LEAK_MARKER = "[envelope-leak]";

export class EnvelopeLeakError extends Error {
  constructor(message: string) {
    super(ENVELOPE_LEAK_MARKER + " " + message);
    this.name = "EnvelopeLeakError";
  }
}

/** True when the message starts with a "{" and closes a top-level object. */
function leadingJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text ?? "").trimStart();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(trimmed.slice(0, i + 1));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Frame signature: transport metadata keys that never appear in intended
 * prose. role==="assistant" plus any one transport key is decisive (chat
 * turns carry none of these); without the assistant role we require at
 * least two transport keys AND a content field, so ordinary JSON bodies
 * (result contracts, settings objects) never trip the guard.
 */
export function looksLikeLlmEnvelopeFrame(value: Record<string, unknown>): boolean {
  const transportKeys = ["api", "usage", "provider", "usageReport", "contextUsage"].filter(
    (key) => key in value,
  );
  if (value.role === "assistant" && transportKeys.length >= 1) {
    return true;
  }
  return transportKeys.length >= 2 && "content" in value;
}

/** Recover intended text from a frame's content field (string or text blocks). */
export function envelopeFrameContentText(frame: Record<string, unknown>): string | null {
  const content: unknown = frame.content;
  if (typeof content === "string") {
    return content.trim() ? content : null;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (block): block is { type?: unknown; text?: unknown } =>
          !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
      )
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return text ? text : null;
  }
  return null;
}

/**
 * Split a write payload into (frame?, recoverable text?).
 * Returns false when the body is not a frame (ordinary text - pass through),
 * null when it is a frame with no recoverable text (reject), and the
 * recovered string when the frame carries content (repair). The scan reads
 * only the LEADING object, so our own marker footer appended after the frame
 * does not defeat detection, and prose that merely MENTIONS frame keys in
 * backticks (audit reports like the #5704 watchdog sweep) passes untouched.
 */
export function splitLlmEnvelopeFrame(body: string): string | null | false {
  const frame = leadingJsonObject(body);
  if (!frame || !looksLikeLlmEnvelopeFrame(frame)) {
    return false;
  }
  return envelopeFrameContentText(frame);
}

/**
 * Write-channel validator (#5704). Apply to every body GitHub-bound write
 * sends. Ordinary text (including JSON that is not a transport frame) is
 * returned unchanged; frames are repaired or rejected.
 */
export function sanitizeGithubWriteBody(body: string, context: string): string {
  const outcome = splitLlmEnvelopeFrame(body);
  if (outcome === false) {
    return body;
  }
  if (typeof outcome === "string") {
    return outcome;
  }
  throw new EnvelopeLeakError(
    context +
      ": payload is a raw LLM transport envelope frame with no recoverable content text - write rejected (#5704)",
  );
}
