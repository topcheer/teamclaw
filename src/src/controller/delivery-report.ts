/**
 * Delivery Report — auto-generated project completion report for TeamClaw sessions.
 *
 * When all tasks in a controller session finish, this module aggregates
 * task results, deliverables, previews, and timeline into a self-contained
 * HTML page that can be shared via URL or pushed to notification channels.
 */

import type {
  TeamState,
  TaskInfo,
  ControllerRunInfo,
  WorkerTaskResultDeliverable,
} from "../types.js";

// ── Report data model ────────────────────────────────────────────────

export type DeliveryReportPhase = {
  taskId: string;
  title: string;
  role: string;
  status: string;
  durationMs: number;
  summary: string;
  keyPoints: string[];
  error?: string;
};

export type DeliveryReportDeliverable = {
  taskId: string;
  kind: string;
  path: string;
  summary: string;
  artifactType?: string;
  previewUrl?: string;
  previewError?: string;
};

export type DeliveryReport = {
  id: string;
  sessionKey: string;
  generatedAt: number;

  // Header
  projectName: string;
  requirementSummary: string;
  status: "completed" | "partial" | "failed";
  totalDurationMs: number;

  // Pipeline
  phases: DeliveryReportPhase[];

  // Deliverables
  deliverables: DeliveryReportDeliverable[];

  // Highlights
  keyPoints: string[];
  blockers: string[];
  followUps: string[];
  notes: string;

  // Meta
  runCount: number;
  taskCount: number;
  rolesUsed: string[];
};

// ── Report generation ────────────────────────────────────────────────

export function generateDeliveryReport(
  sessionKey: string,
  state: TeamState,
  normalizeSessionKey: (key: unknown) => string,
): DeliveryReport | null {
  const normalizedKey = normalizeSessionKey(sessionKey);

  // Collect all controller runs for this session
  const runs = Object.values(state.controllerRuns)
    .filter((r) => normalizeSessionKey(r.sessionKey) === normalizedKey)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (runs.length === 0) return null;

  // Collect all task IDs across all runs
  const allTaskIds = Array.from(new Set(runs.flatMap((r) => r.createdTaskIds)));
  const tasks = allTaskIds
    .map((id) => state.tasks[id])
    .filter((t): t is TaskInfo => !!t)
    .sort((a, b) => a.createdAt - b.createdAt);

  if (tasks.length === 0) return null;

  // Determine overall status
  const failedTasks = tasks.filter((t) => t.status === "failed");
  const completedTasks = tasks.filter((t) => t.status === "completed");
  const activeTasks = tasks.filter((t) =>
    t.status === "in_progress" || t.status === "pending" || t.status === "assigned",
  );
  let status: DeliveryReport["status"] = "completed";
  if (failedTasks.length > 0 && completedTasks.length === 0) status = "failed";
  else if (activeTasks.length > 0 || failedTasks.length > 0) status = "partial";

  // Find the best project name and summary
  const latestManifest = [...runs].reverse().find((r) => r.manifest)?.manifest;
  const firstManifest = runs.find((r) => r.manifest)?.manifest;
  const projectName =
    latestManifest?.projectName || firstManifest?.projectName || runs[0].projectDir || "Untitled Project";
  const requirementSummary =
    firstManifest?.requirementSummary || runs[0].request || "";

  // Timeline
  const sessionStart = runs[0].createdAt;
  const lastCompletion = Math.max(...tasks.map((t) => t.completedAt ?? t.updatedAt));
  const totalDurationMs = lastCompletion - sessionStart;

  // Build phases
  const phases: DeliveryReportPhase[] = tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    role: task.assignedRole ?? "unknown",
    status: task.status,
    durationMs: (task.completedAt ?? task.updatedAt) - task.createdAt,
    summary: task.resultContract?.summary ?? task.result?.slice(0, 200) ?? "",
    keyPoints: task.resultContract?.keyPoints ?? [],
    error: task.error,
  }));

  // Collect deliverables
  const deliverables: DeliveryReportDeliverable[] = [];
  for (const task of tasks) {
    if (!task.resultContract?.deliverables) continue;
    for (const [di, d] of task.resultContract.deliverables.entries()) {
      const preview = resolvePreviewInfo(d, task.id, di, state);
      deliverables.push({
        taskId: task.id,
        kind: d.kind,
        path: d.value,
        summary: d.summary ?? "",
        artifactType: d.artifactType,
        previewUrl: preview.url,
        previewError: preview.error,
      });
    }
  }

  // Aggregate highlights
  const keyPoints = tasks.flatMap((t) => t.resultContract?.keyPoints ?? []);
  const blockers = tasks.flatMap((t) => t.resultContract?.blockers ?? []);
  const followUps = tasks.flatMap((t) =>
    (t.resultContract?.followUps ?? []).map(
      (f) => `${f.type}${f.targetRole ? ` (${f.targetRole})` : ""}: ${f.reason}`,
    ),
  );
  const notes = latestManifest?.notes ?? "";

  const rolesUsed = Array.from(new Set(tasks.map((t) => t.assignedRole).filter(Boolean) as string[]));

  return {
    id: `report-${normalizedKey}`,
    sessionKey: normalizedKey,
    generatedAt: Date.now(),
    projectName,
    requirementSummary,
    status,
    totalDurationMs,
    phases,
    deliverables,
    keyPoints,
    blockers,
    followUps,
    notes,
    runCount: runs.length,
    taskCount: tasks.length,
    rolesUsed,
  };
}

function resolvePreviewInfo(
  deliverable: WorkerTaskResultDeliverable,
  taskId: string,
  deliverableIndex: number,
  state: TeamState,
): { url?: string; error?: string } {
  if (deliverable.liveUrl) return { url: deliverable.liveUrl };
  // Find preview record for this specific deliverable
  const previewId = `preview-${taskId}-${deliverableIndex}`;
  const exact = (state.previews ?? {})[previewId];
  if (exact) {
    if (exact.status === "healthy") return { url: exact.liveUrl };
    if (exact.status === "failed") return { error: exact.lastError ?? "Preview failed" };
    if (exact.status === "stopped") return { error: "Preview stopped" };
    // launching/starting — still pending
    return { error: "Preview is still starting…" };
  }
  // Fallback: find any healthy preview for this task
  const previews = Object.values(state.previews ?? {});
  const match = previews.find((p) => p.taskId === taskId && p.status === "healthy");
  if (match) return { url: match.liveUrl };
  // Check for any failed preview for this task
  const failed = previews.find((p) => p.taskId === taskId && p.status === "failed");
  if (failed) return { error: failed.lastError ?? "Preview failed" };
  return {};
}

// ── Session completion detection ─────────────────────────────────────

export function isSessionComplete(
  sessionKey: string,
  state: TeamState,
  normalizeSessionKey: (key: unknown) => string,
): boolean {
  const normalizedKey = normalizeSessionKey(sessionKey);
  const runs = Object.values(state.controllerRuns)
    .filter((r) => normalizeSessionKey(r.sessionKey) === normalizedKey)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (runs.length === 0) return false;

  // Collect all tasks for this session
  const taskIds = new Set(runs.flatMap((r) => r.createdTaskIds));
  if (taskIds.size === 0) return false;

  // Check if any task is still active
  for (const taskId of taskIds) {
    const task = state.tasks[taskId];
    if (!task) continue;
    if (task.status !== "completed" && task.status !== "failed") {
      return false;
    }
  }

  // Check if the latest run still has active deferred tasks
  const latestWithManifest = runs.find((r) => r.manifest);
  if (latestWithManifest?.manifest?.deferredTasks?.length) {
    // There are deferred tasks — a follow-up run should advance them.
    // Only consider complete if the latest run also says requirementFullyComplete.
    if (!latestWithManifest.manifest.requirementFullyComplete) {
      return false;
    }
  }

  // Check if any run is still actively executing
  const activeRun = runs.find((r) => r.status === "pending" || r.status === "running");
  if (activeRun) return false;

  return true;
}

// ── HTML rendering ───────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"]);

function isImagePath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

const STATUS_EMOJI: Record<string, string> = {
  completed: "✅",
  failed: "❌",
  partial: "⚠️",
  in_progress: "🔄",
  pending: "⏳",
  assigned: "📋",
  blocked: "🚫",
};

export function renderReportHtml(report: DeliveryReport): string {
  const statusEmoji = STATUS_EMOJI[report.status] ?? "❓";
  const statusLabel =
    report.status === "completed"
      ? "Completed"
      : report.status === "failed"
        ? "Failed"
        : "Partial";

  const phasesHtml = report.phases
    .map((phase) => {
      const emoji = STATUS_EMOJI[phase.status] ?? "❓";
      const duration = formatDuration(phase.durationMs);
      const errorHtml = phase.error
        ? `<div class="phase-error">Error: ${escapeHtml(phase.error.slice(0, 200))}</div>`
        : "";
      const keyPointsHtml =
        phase.keyPoints.length > 0
          ? `<ul class="phase-keypoints">${phase.keyPoints.map((kp) => `<li>${escapeHtml(kp)}</li>`).join("")}</ul>`
          : "";
      return `
      <div class="phase-card phase-${phase.status}">
        <div class="phase-header">
          <span class="phase-emoji">${emoji}</span>
          <span class="phase-title">${escapeHtml(phase.title)}</span>
          <span class="phase-role">${escapeHtml(phase.role)}</span>
          <span class="phase-duration">${duration}</span>
        </div>
        <div class="phase-summary">${escapeHtml(phase.summary)}</div>
        ${errorHtml}
        ${keyPointsHtml}
      </div>`;
    })
    .join("\n");

  const deliverablesHtml = report.deliverables
    .map((d) => {
      const kindIcon =
        d.artifactType === "web-app" || d.artifactType === "static-site"
          ? "🌐"
          : d.artifactType === "document"
            ? "📝"
            : d.kind === "directory"
              ? "📁"
              : d.kind === "command"
                ? "💻"
                : isImagePath(d.path)
                  ? "🖼️"
                  : "📄";
      let previewHtml = "";
      if (d.previewUrl) {
        previewHtml = `<div class="deliverable-preview">
            <a href="${escapeHtml(d.previewUrl)}" target="_blank" class="preview-link">🔗 Open Live Preview</a>
            <iframe src="${escapeHtml(d.previewUrl)}" class="preview-iframe" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
          </div>`;
      } else if (d.previewError) {
        previewHtml = `<div class="preview-error">⚠️ ${escapeHtml(d.previewError)}</div>`;
      } else if (d.kind === "command") {
        previewHtml = `<div class="deliverable-run-hint">💡 Run: <code>${escapeHtml(d.path)}</code></div>`;
      } else if (d.artifactType === "document") {
        previewHtml = `<div class="deliverable-doc-hint">📖 Document — view in workspace at <code>${escapeHtml(d.path)}</code></div>`;
      } else if (isImagePath(d.path)) {
        // Serve image via workspace file endpoint if available
        previewHtml = `<div class="deliverable-image-hint">🖼️ Image file — open from workspace</div>`;
      }
      return `
      <div class="deliverable-card">
        <div class="deliverable-header">
          <span class="deliverable-icon">${kindIcon}</span>
          <span class="deliverable-path">${escapeHtml(d.path)}</span>
        </div>
        <div class="deliverable-summary">${escapeHtml(d.summary)}</div>
        ${previewHtml}
      </div>`;
    })
    .join("\n");

  const keyPointsHtml =
    report.keyPoints.length > 0
      ? `<section class="section">
          <h2>💡 Key Points</h2>
          <ul>${report.keyPoints.map((kp) => `<li>${escapeHtml(kp)}</li>`).join("")}</ul>
        </section>`
      : "";

  const blockersHtml =
    report.blockers.length > 0
      ? `<section class="section section-warning">
          <h2>🚧 Blockers</h2>
          <ul>${report.blockers.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
        </section>`
      : "";

  const followUpsHtml =
    report.followUps.length > 0
      ? `<section class="section">
          <h2>📌 Follow-ups</h2>
          <ul>${report.followUps.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
        </section>`
      : "";

  const notesHtml = report.notes
    ? `<section class="section"><h2>📝 Notes</h2><p>${escapeHtml(report.notes)}</p></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TeamClaw Report — ${escapeHtml(report.projectName)}</title>
<style>
  :root {
    --bg: #f8f9fa; --card: #fff; --border: #e2e8f0; --text: #1a202c;
    --muted: #718096; --accent: #3182ce; --success: #38a169; --danger: #e53e3e;
    --warning: #d69e2e; --radius: 10px; --shadow: 0 1px 3px rgba(0,0,0,.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg); color: var(--text); line-height: 1.6;
    max-width: 900px; margin: 0 auto; padding: 24px 16px;
  }
  .header {
    background: linear-gradient(135deg, #2d3748, #1a365d);
    color: #fff; border-radius: var(--radius); padding: 32px; margin-bottom: 24px;
  }
  .header h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; }
  .header-meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: .9rem; opacity: .85; }
  .header-meta span { display: flex; align-items: center; gap: 4px; }
  .requirement {
    background: rgba(255,255,255,.1); border-radius: 6px;
    padding: 12px; margin-top: 16px; font-size: .9rem; line-height: 1.5;
  }
  .section { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px; margin-bottom: 16px; box-shadow: var(--shadow); }
  .section h2 { font-size: 1.1rem; margin-bottom: 12px; }
  .section ul { padding-left: 20px; }
  .section li { margin-bottom: 4px; font-size: .9rem; }
  .section-warning { border-left: 4px solid var(--warning); }

  /* Pipeline */
  .pipeline { display: flex; flex-direction: column; gap: 8px; }
  .phase-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 14px 16px; box-shadow: var(--shadow); position: relative;
  }
  .phase-card.phase-completed { border-left: 4px solid var(--success); }
  .phase-card.phase-failed { border-left: 4px solid var(--danger); }
  .phase-card.phase-in_progress { border-left: 4px solid var(--accent); }
  .phase-header {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;
  }
  .phase-title { font-weight: 600; flex: 1; }
  .phase-role {
    background: #edf2f7; color: var(--muted); font-size: .75rem; padding: 2px 8px;
    border-radius: 12px; text-transform: uppercase; letter-spacing: .5px;
  }
  .phase-duration { font-size: .8rem; color: var(--muted); }
  .phase-summary { font-size: .85rem; color: #4a5568; }
  .phase-error { font-size: .85rem; color: var(--danger); margin-top: 6px; }
  .phase-keypoints { font-size: .8rem; color: var(--muted); margin-top: 6px; padding-left: 18px; }

  /* Deliverables */
  .deliverable-card {
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 16px; margin-bottom: 12px; box-shadow: var(--shadow);
  }
  .deliverable-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .deliverable-icon { font-size: 1.3rem; }
  .deliverable-path { font-family: "SF Mono", Monaco, monospace; font-size: .85rem; color: var(--accent); }
  .deliverable-summary { font-size: .85rem; color: #4a5568; }
  .deliverable-preview { margin-top: 12px; }
  .preview-link {
    display: inline-block; margin-bottom: 8px; font-size: .85rem;
    color: var(--accent); text-decoration: none; font-weight: 500;
  }
  .preview-link:hover { text-decoration: underline; }
  .preview-iframe {
    width: 100%; height: 400px; border: 1px solid var(--border);
    border-radius: 6px; background: #fff;
  }
  .preview-error {
    margin-top: 8px; padding: 10px 14px; background: #fff5f5; border: 1px solid #fed7d7;
    border-radius: 6px; font-size: .85rem; color: var(--danger);
  }
  .deliverable-run-hint {
    margin-top: 8px; padding: 8px 12px; background: #ebf8ff; border: 1px solid #bee3f8;
    border-radius: 6px; font-size: .85rem; color: #2a4365;
  }
  .deliverable-run-hint code {
    background: #e2e8f0; padding: 1px 6px; border-radius: 4px; font-size: .82rem;
  }
  .deliverable-doc-hint {
    margin-top: 8px; padding: 8px 12px; background: #f0fff4; border: 1px solid #c6f6d5;
    border-radius: 6px; font-size: .85rem; color: #22543d;
  }
  .deliverable-doc-hint code, .deliverable-image-hint code {
    background: #e2e8f0; padding: 1px 6px; border-radius: 4px; font-size: .82rem;
  }
  .deliverable-image-hint {
    margin-top: 8px; padding: 8px 12px; background: #faf5ff; border: 1px solid #e9d8fd;
    border-radius: 6px; font-size: .85rem; color: #44337a;
  }

  .footer {
    text-align: center; font-size: .8rem; color: var(--muted);
    padding: 16px 0; margin-top: 8px;
  }

  @media (max-width: 600px) {
    body { padding: 12px 8px; }
    .header { padding: 20px 16px; }
    .header h1 { font-size: 1.2rem; }
    .preview-iframe { height: 280px; }
  }
</style>
</head>
<body>
  <div class="header">
    <h1>${statusEmoji} ${escapeHtml(report.projectName)}</h1>
    <div class="header-meta">
      <span>Status: <strong>${statusLabel}</strong></span>
      <span>⏱️ ${formatDuration(report.totalDurationMs)}</span>
      <span>📋 ${report.taskCount} task${report.taskCount !== 1 ? "s" : ""}</span>
      <span>👥 ${report.rolesUsed.join(", ") || "—"}</span>
    </div>
    <div class="requirement">${escapeHtml(report.requirementSummary)}</div>
  </div>

  <section class="section">
    <h2>📋 Task Pipeline</h2>
    <div class="pipeline">
      ${phasesHtml}
    </div>
  </section>

  ${report.deliverables.length > 0 ? `
  <section class="section">
    <h2>📦 Deliverables</h2>
    ${deliverablesHtml}
  </section>` : ""}

  ${keyPointsHtml}
  ${blockersHtml}
  ${followUpsHtml}
  ${notesHtml}

  <div class="footer">
    Generated by TeamClaw · ${new Date(report.generatedAt).toLocaleString()}
  </div>
</body>
</html>`;
}
