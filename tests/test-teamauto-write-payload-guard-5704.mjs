// Regression test for ggcode issue #5704: LLM envelope/frame leakage into
// GitHub write surfaces. Three documented cases (2026-11-16):
//   #5699 - raw frame posted verbatim as an issue comment (watchdog-collected)
//   #5703 - PR body was nothing but the frame JSON (PR<->issue linkage only via title)
//   #5687 - write timeout, output never landed (predates the #24 write-back retry ladder)
// Root cause: extractLastAssistantTurn serialized the whole last assistant
// message when its content was neither a string nor text blocks, so an empty
// transport frame (content:[] + api/provider/usage + stopReason:error +
// errorMessage:"Request timed out.") became the worker "final reply"; the
// write-back ladder then delivered that text verbatim to every surface.
// Fix under test, two layers:
//   (1) extraction (src/src/task-executor.ts): frame-shaped or textless
//       messages yield "" - never the serialized frame object.
//   (2) write channel (src/src/teamauto/write-payload-guard.ts +
//       github-client.ts): every GitHub write body is validated - frames with
//       recoverable content text are repaired to that text, frames without
//       are rejected (EnvelopeLeakError), and the scheduler ladder marks such
//       rejections TERMINALLY (no retry-without-validation burn).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

const guardMod = await import(
  path.join(projectRoot, "src", "dist", "src", "teamauto", "write-payload-guard.js")
).catch(() => null);
assert.ok(guardMod, "write-payload-guard module must be built (run npm --prefix src run build first)");

const texecMod = await import(
  path.join(projectRoot, "src", "dist", "src", "task-executor.js")
).catch(() => null);
assert.ok(texecMod, "task-executor module must be built (run npm --prefix src run build first)");

// The authentic leaked frames, captured verbatim from the live surfaces:
const FRAME_5699 = "{\"role\":\"assistant\",\"content\":[],\"api\":\"openai-completions\",\"provider\":\"zai\",\"model\":\"glm-5.3\",\"usage\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0},\"usageReport\":{\"state\":\"unavailable\"},\"contextUsage\":{\"state\":\"unavailable\"}},\"stopReason\":\"error\",\"timestamp\":1794813572671,\"errorMessage\":\"Request timed out.\",\"errorCode\":\"UND_ER\u2026EOUT\",\"diagnostics\":[{\"type\":\"provider_transport_failure\",\"timestamp\":1794813583194,\"error\":{\"name\":\"ThrownValue\",\"message\":\"Request timed out.\"},\"details\":{\"eventsEmitted\":false,\"phase\":\"before_message_stream_start\"}}],\"__openclaw\":{\"runId\":\"1a94d823-fcaa-4bcb-a32f-9a558fe629b0\",\"id\":\"8e288024-faee-4dcc-a996-be000df43890\",\"recordTimestampMs\":1794813583198,\"transcriptPosition\":{\"source\":\"EjDZbuP0lM9mJjONQ0amhTqzhURSAYsB3dL04-TZTfY\",\"rawSeq\":611},\"seq\":450}}\n\n---\n[teamclaw:developer] autonomous via TeamClaw\n\nDelivered as PR: https://github.com/topcheer/ggcode/pull/5703";
const FRAME_5703 = "{\"role\":\"assistant\",\"content\":[],\"api\":\"openai-completions\",\"provider\":\"zai\",\"model\":\"glm-5.3\",\"usage\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0},\"usageReport\":{\"state\":\"unavailable\"},\"contextUsage\":{\"state\":\"unavailable\"}},\"stopReason\":\"error\",\"timestamp\":1794813572671,\"errorMessage\":\"Request timed out.\",\"errorCode\":\"UND_ER\u2026EOUT\",\"diagnostics\":[{\"type\":\"provider_transport_failure\",\"timestamp\":1794813583194,\"error\":{\"name\":\"ThrownValue\",\"message\":\"Request timed out.\"},\"details\":{\"eventsEmitted\":false,\"phase\":\"before_message_stream_start\"}}],\"__openclaw\":{\"runId\":\"1a94d823-fcaa-4bcb-a32f-9a558fe629b0\",\"id\":\"8e288024-faee-4dcc-a996-be000df43890\",\"recordTimestampMs\":1794813583198,\"transcriptPosition\":{\"source\":\"EjDZbuP0lM9mJjONQ0amhTqzhURSAYsB3dL04-TZTfY\",\"rawSeq\":611},\"seq\":450}}\n\n---\n[teamclaw:developer] autonomous via TeamClaw";

const FOOTER = "\n\n_[teamclaw:owner|task:unit-5704]_";
const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// ---------------------------------------------------------------------------
// Layer 2 unit tests: frame detection / repair / rejection
// ---------------------------------------------------------------------------
{
  const { splitLlmEnvelopeFrame, sanitizeGithubWriteBody, EnvelopeLeakError, ENVELOPE_LEAK_MARKER } = guardMod;

  // Case 1 + case 3 payloads: authentic frames, empty content -> reject.
  for (const [name, frame] of [["#5699 comment", FRAME_5699], ["#5703 PR body", FRAME_5703]]) {
    assert.equal(splitLlmEnvelopeFrame(frame), null, name + ": empty-content frame must split to null");
    assert.throws(
      () => sanitizeGithubWriteBody(frame, name),
      (err) => err instanceof EnvelopeLeakError
        && err.message.includes(ENVELOPE_LEAK_MARKER)
        && err.message.includes("#5704"),
      name + ": guard must reject with EnvelopeLeakError",
    );
  }

  // The write-back ladder composes task.result + marker footer: the trailing
  // prose must NOT defeat detection (leading-object scan).
  assert.equal(splitLlmEnvelopeFrame(FRAME_5699 + FOOTER), null, "frame + footer still detected");
  assert.throws(() => sanitizeGithubWriteBody(FRAME_5703 + FOOTER, "pr body"), guardMod.EnvelopeLeakError);

  // Repair: frame whose content carries text is reduced to that text.
  const withText = JSON.stringify({
    role: "assistant",
    content: [{ type: "text", text: "The fix landed; see PR #1234." }, { type: "tool_call", name: "exec" }],
    api: "openai-completions",
    provider: "zai",
    usage: { totalTokens: 3 },
  });
  assert.equal(splitLlmEnvelopeFrame(withText), "The fix landed; see PR #1234.");
  assert.equal(
    sanitizeGithubWriteBody(withText + FOOTER, "comment"),
    "The fix landed; see PR #1234.",
    "repair returns ONLY the recovered content text",
  );
  const withString = JSON.stringify({ role: "assistant", content: "prose in a frame", api: "anthropic", usage: {} });
  assert.equal(sanitizeGithubWriteBody(withString, "comment"), "prose in a frame");

  // Pass-through: prose that merely MENTIONS frame markers (audit reports like
  // the #5704 watchdog sweep) must never be blocked or rewritten.
  const auditProse = 'Signatures scanned: `api":"openai-completions` and `usage":{"prompt_tokens` - 0 hits.';
  assert.equal(splitLlmEnvelopeFrame(auditProse), false, "prose is not a frame");
  assert.equal(sanitizeGithubWriteBody(auditProse, "audit"), auditProse);

  // Pass-through: JSON bodies that are NOT transport frames (result contracts).
  const contractBody = JSON.stringify({ outcome: "completed", summary: "shipped", api: undefined });
  assert.equal(splitLlmEnvelopeFrame(contractBody), false, "result-contract JSON is not a frame");
  const normalReply = "### qa section\n\nAll 9/9 checks pass. Done.";
  assert.equal(sanitizeGithubWriteBody(normalReply, "umbrella"), normalReply);

  // Pass-through: truncated/garbage leading brace is not a frame.
  assert.equal(splitLlmEnvelopeFrame("{not json at all"), false);

  // Embedded frames (#5685 umbrella section shape): task.result lands between
  // the section header and the marker footer, so the frame is NOT the leading
  // object. Line-level detection must still repair/reject it.
  const sectionWithText = "### qa section\n\n" + withText + FOOTER;
  const repairedSection = sanitizeGithubWriteBody(sectionWithText, "umbrella");
  assert.ok(repairedSection.includes("The fix landed; see PR #1234."), "embedded frame text recovered in place");
  assert.ok(!repairedSection.includes('"role":"assistant"'), "no frame JSON left in the section body");
  const sectionEmpty = "### qa section\n\n" + FRAME_5699.split("\n\n---")[0] + "\n\n---\n[teamclaw:developer] autonomous via TeamClaw";
  assert.throws(
    () => sanitizeGithubWriteBody(sectionEmpty, "umbrella"),
    (err) => err instanceof EnvelopeLeakError && err.message.includes("embeds only"),
    "textless embedded frame with only chrome left -> reject",
  );

  // Multi-line/pretty-printed JSON is not a standalone frame line: ordinary
  // JSON discussion bodies must pass through untouched.
  const prettyJson = '{\n  "summary": "x",\n  "usage": "discussed below"\n}';
  assert.equal(sanitizeGithubWriteBody(prettyJson, "comment"), prettyJson);
}

// ---------------------------------------------------------------------------
// Layer 1 unit tests: extraction never mints frame JSON as reply text
// ---------------------------------------------------------------------------
{
  const { extractLastAssistantTurn } = texecMod;
  // The live payloads carry the marker footer after the frame (write-back
  // composition); the session-message fixture is the bare frame object.
  const frameMessage = JSON.parse(FRAME_5699.split("\n\n---")[0]);
  const frame5703 = JSON.parse(FRAME_5703.split("\n\n---")[0]);

  // The exact live shape: transport frame as the last assistant message.
  // Pre-fix: turn.text === JSON.stringify(frame) - the whole leak.
  const turn = extractLastAssistantTurn([{ role: "user", content: "go" }, frameMessage]);
  assert.equal(turn.text, "", "#5699 frame must extract to empty text, not serialized JSON");
  assert.equal(turn.backgroundPending, false);
  const turn5703 = extractLastAssistantTurn([frame5703]);
  assert.equal(turn5703.text, "", "#5703 frame must extract to empty text");

  // Repair at extraction: frame with recoverable content yields that text.
  assert.equal(
    extractLastAssistantTurn([{ role: "assistant", content: "plain string", usage: { totalTokens: 1 } }]).text,
    "plain string",
  );
  assert.equal(
    extractLastAssistantTurn([{ role: "assistant", content: { type: "text", text: "direct object" } }]).text,
    "direct object",
    "content-as-text-object is salvaged",
  );

  // No regression on ordinary turns.
  assert.equal(
    extractLastAssistantTurn([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]).text,
    "hello",
  );
  assert.equal(extractLastAssistantTurn([{ role: "user", content: "only user" }]).text, "");
}

// ---------------------------------------------------------------------------
// Layer 2 behavioral test: the ladder rejects (terminally) instead of posting
// ---------------------------------------------------------------------------
{
  const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tc-5704-"));
  process.env.OPENCLAW_STATE_DIR = stateDir; // isolate the store path from the real HOME
  const storeFile = path.join(stateDir, "plugins", "teamclaw", "teamauto.json");

  const teamState = {
    tasks: {
      "task-leak": {
        id: "task-leak",
        title: "[takeOwnership] leak",
        description: "d",
        status: "completed",
        result: FRAME_5699, // corrupted final reply (pre-fix stored state)
        writeMode: "read-only",
        assignedRole: "owner",
      },
      "task-repair": {
        id: "task-repair",
        title: "[takeOwnership] repair",
        description: "d",
        status: "completed",
        result: JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Deliverable summary from inside a frame." }],
          api: "openai-completions",
          provider: "zai",
          usage: { totalTokens: 2 },
        }),
        writeMode: "read-only",
        assignedRole: "qa",
      },
    },
  };

  await fs.promises.mkdir(path.dirname(storeFile), { recursive: true });
  await fs.promises.writeFile(storeFile, JSON.stringify({
    version: 1,
    repos: [{ id: "acme/widget", enabled: true, schedule: "*/30 * * * *", addedAt: 1, lastSweepAt: 0, lastSweepSummary: null, pausedReason: null, dryRunDone: true }],
    writebacks: [
      { taskId: "task-leak", action: "issueComment", repoId: "acme/widget", targetId: 42, doneAt: null, prUrl: null, error: null },
      { taskId: "task-repair", action: "issueComment", repoId: "acme/widget", targetId: 43, doneAt: null, prUrl: null, error: null },
    ],
    activity: [],
    budget: { maxTasksPerDay: 150, firstSweepDryRun: true, tasksToday: 0, dayStamp: "2026-11-16" },
  }), "utf8");

  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (init && String(init.method || "GET").toUpperCase() === "POST" && target.includes("/comments")) {
      posted.push({ url: target, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 4242 }) };
    }
    return realFetch(url, init);
  };

  try {
    const schedMod = await import(path.join(projectRoot, "src", "dist", "src", "teamauto", "scheduler.js"));
    const scheduler = schedMod.createTeamAutoScheduler({
      logger: noopLogger,
      auth: { getAuthHeaders: async () => ({ Authorization: "Bearer test" }) },
      getTeamState: () => teamState,
      updateTeamState: (fn) => { fn(teamState); return teamState; },
      onTasksCreated: async () => {},
    });
    await scheduler.reconcileWritebacks();

    const store = JSON.parse(await fs.promises.readFile(storeFile, "utf8"));
    const rows = store.writebacks;

    // task-leak: REJECTED - no POST ever hit the wire with the frame body.
    const leakPosts = posted.filter((p) => p.url.endsWith("/issues/42/comments"));
    assert.equal(leakPosts.length, 0, "envelope frame must never be POSTed as a comment body");
    const leakRow = rows.find((r) => r.taskId === "task-leak");
    assert.ok(leakRow, "rejected entry stays in the store");
    assert.ok(!leakRow.doneAt, "rejected entry is not done");
    assert.equal((leakRow.attempts ?? 0), 1, "terminal on the FIRST attempt - no retry ladder burn");
    assert.ok(leakRow.failedAt, "rejection is terminal (failedAt set)");
    assert.ok(String(leakRow.error).includes("[envelope-leak]"), "failure names the envelope leak");

    // task-repair: frame with recoverable content - the POST carries ONLY the
    // recovered text (plus the ladder's marker footer), never the frame JSON.
    const repairPosts = posted.filter((p) => p.url.endsWith("/issues/43/comments"));
    assert.equal(repairPosts.length, 1, "repairable frame is delivered exactly once");
    const sentBody = String(repairPosts[0].body.body);
    assert.ok(sentBody.startsWith("Deliverable summary from inside a frame."), "posted body is the repaired text");
    assert.ok(!sentBody.includes('"role":"assistant"') && !sentBody.includes("openai-completions"), "no frame JSON in the posted body");
    // Delivered entries are dropped from the queue entirely (keep-last-500):
    // absence of the row IS the success end-state for the repaired task.
    const repairRow = rows.find((r) => r.taskId === "task-repair");
    assert.ok(!repairRow || (!repairRow.error && repairRow.doneAt), "repaired delivery is a clean success");
  } finally {
    globalThis.fetch = realFetch;
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  }
}

console.log("PASS test-teamauto-write-payload-guard-5704: frame leak rejected terminally, recoverable frames repaired, extraction never serializes frames");
