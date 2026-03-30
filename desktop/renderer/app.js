(function () {
  "use strict";

  const desktop = window.teamclawDesktop;
  const STORAGE_KEY = "teamclaw-desktop-conversation";
  const SESSION_KEY = "teamclaw-desktop-session";

  const state = {
    settings: null,
    controllerUrl: "",
    ws: null,
    refreshTimer: null,
    currentView: "mission",
    taskFilter: "all",
    noticeFilter: "all",
    conversation: loadConversation(),
    sessionKey: loadSessionKey(),
    teamStatus: {
      tasks: [],
      workers: [],
      clarifications: [],
      controllerRuns: [],
      messages: [],
    },
    reports: [],
    notifications: [],
    localController: null,
    selectedTaskId: "",
    selectedPlanningRunId: "",
    selectedWorkspacePath: "",
    selectedWorkspaceFile: null,
    workspaceView: "source",
    workspaceTree: [],
  };

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  function normalizeBaseUrl(input) {
    const raw = String(input || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `http://${raw}`;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value == null ? "" : value);
    return div.innerHTML;
  }

  function nl2br(value) {
    return escapeHtml(value).replace(/\n/g, "<br>");
  }

  function formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString();
  }

  function formatDateTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleString();
  }

  function humanize(value) {
    return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let i = 0;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i += 1;
    }
    return `${size >= 10 || i === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[i]}`;
  }

  function uniqueById(items) {
    const map = new Map();
    (items || []).forEach((item) => {
      if (item && item.id) map.set(item.id, item);
    });
    return Array.from(map.values());
  }

  function loadConversation() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveConversation() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.conversation.slice(-60)));
    } catch {
      // ignore
    }
  }

  function loadSessionKey() {
    try {
      const existing = localStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      const next = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `desktop-${Date.now()}`;
      localStorage.setItem(SESSION_KEY, next);
      return next;
    } catch {
      return `desktop-${Date.now()}`;
    }
  }

  function pushConversation(from, content) {
    state.conversation.push({
      id: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      from,
      content,
      createdAt: Date.now(),
    });
    state.conversation = state.conversation.slice(-60);
    saveConversation();
    renderConversation();
  }

  function controllerApi(path) {
    return `${state.controllerUrl}/api/v1${path}`;
  }

  async function apiGet(path) {
    const response = await fetch(controllerApi(path));
    if (!response.ok) {
      throw new Error(`GET ${path} failed (${response.status})`);
    }
    return response.json();
  }

  async function apiPost(path, body) {
    const response = await fetch(controllerApi(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      let message = `POST ${path} failed (${response.status})`;
      try {
        const data = await response.json();
        message = data.error || data.message || message;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    return response.json();
  }

  function setConnectionPill(kind, text) {
    const el = $("#connection-pill");
    if (!el) return;
    el.className = `pill pill-${kind}`;
    el.textContent = text;
  }

  function setLocalPill(kind, text) {
    const el = $("#local-pill");
    if (!el) return;
    el.className = `pill pill-${kind}`;
    el.textContent = text;
  }

  function setStatusLine(text) {
    const el = $("#status-line");
    if (el) el.textContent = text;
  }

  function setSummaryLine(text) {
    const el = $("#summary-line");
    if (el) el.textContent = text;
  }

  function normalizeArray(input) {
    return Array.isArray(input) ? input : Object.values(input || {});
  }

  function summarize(status) {
    const tasks = normalizeArray(status.tasks);
    const clarifications = normalizeArray(status.clarifications);
    const workers = normalizeArray(status.workers);
    const counts = tasks.reduce((acc, task) => {
      const key = String(task.status || "unknown");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      workers: workers.length,
      pending: counts.pending || 0,
      active: (counts.assigned || 0) + (counts.in_progress || 0) + (counts.review || 0),
      blocked: (counts.blocked || 0) + clarifications.filter((item) => !item.answer).length,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
    };
  }

  function renderMissionSummary() {
    const summary = summarize(state.teamStatus);
    $("#attention-count").textContent = String(summary.blocked);
    $("#active-count").textContent = String(summary.active);
    $("#delivery-count").textContent = String(summary.completed);
    setSummaryLine(`${summary.workers} workers • ${summary.pending} pending • ${summary.active} active • ${summary.completed} completed`);

    const grid = $("#summary-grid");
    if (!grid) return;
    grid.innerHTML = [
      ["Workers", summary.workers],
      ["Pending", summary.pending],
      ["Blocked", summary.blocked],
      ["Completed", summary.completed],
    ].map(([label, value]) => {
      return `<div class="metric-card"><span class="metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
    }).join("");
  }

  function renderConversation() {
    const el = $("#conversation-list");
    if (!el) return;
    if (state.conversation.length === 0) {
      el.innerHTML = '<div class="empty-state">No controller conversation yet.</div>';
      return;
    }
    el.innerHTML = state.conversation.slice().reverse().map((entry) => {
      return (
        `<article class="conversation-entry ${escapeHtml(entry.from)}">` +
        `  <div class="entry-meta">${escapeHtml(humanize(entry.from))} • ${escapeHtml(formatDateTime(entry.createdAt))}</div>` +
        `  <div class="entry-body">${nl2br(entry.content)}</div>` +
        `</article>`
      );
    }).join("");
  }

  function upsertNotification(item) {
    const existing = state.notifications.find((entry) => entry.id === item.id);
    const isNew = !existing;
    if (existing) {
      Object.assign(existing, item, { updatedAt: Date.now(), count: (existing.count || 1) + 1 });
    } else {
      state.notifications.unshift({ updatedAt: Date.now(), count: 1, ...item });
    }
    state.notifications = uniqueById(state.notifications).slice(0, 100);
    renderNotifications();
    if (isNew && item.desktopAlert) {
      desktop.showNotification({ title: item.title, body: item.body });
    }
  }

  function notificationActionsForTask(taskId) {
    return [
      { kind: "switch-view", label: "Open task", view: "tasks", taskId },
      { kind: "switch-view", label: "Open tasks", view: "tasks" },
    ];
  }

  function renderNotifications() {
    const list = $("#notification-list");
    if (!list) return;
    const filtered = state.notifications.filter((item) => state.noticeFilter === "all" || item.category === state.noticeFilter);
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state">No notifications for this view yet.</div>';
      return;
    }
    list.innerHTML = filtered.map((item) => {
      const actions = Array.isArray(item.actions) ? item.actions : [];
      const meta = [item.meta, item.count > 1 ? `${item.count} updates` : null, formatTime(item.updatedAt)].filter(Boolean).join(" • ");
      return (
        `<article class="notification-card ${escapeHtml(item.category || "active")}">` +
        `  <div class="notification-head"><div class="notification-title">${escapeHtml(item.title)}</div><div class="notification-meta">${escapeHtml(meta)}</div></div>` +
        `  <div class="notification-body">${nl2br(item.body)}</div>` +
        `  <div class="notification-actions">` +
        actions.map((action) => `<button type="button" data-notice-action="${escapeHtml(action.kind)}" data-view="${escapeHtml(action.view || "")}" data-task-id="${escapeHtml(action.taskId || "")}" data-report-url="${escapeHtml(action.reportUrl || "")}" data-run-id="${escapeHtml(action.runId || "")}">${escapeHtml(action.label)}</button>`).join("") +
        `  </div>` +
        `</article>`
      );
    }).join("");
  }

  function updateNotificationsFromStatus() {
    normalizeArray(state.teamStatus.clarifications).filter((item) => !item.answer).forEach((item) => {
      upsertNotification({
        id: `clarification:${item.id}`,
        category: "attention",
        title: "Clarification needed",
        body: item.question || item.blockingReason || "A worker is waiting for human input.",
        meta: item.taskId ? `Task ${item.taskId}` : "Controller",
        actions: [
          { kind: "switch-view", label: "Open clarifications", view: "clarifications" },
          item.taskId ? { kind: "switch-view", label: "Open task", view: "tasks", taskId: item.taskId } : null,
        ].filter(Boolean),
        desktopAlert: false,
      });
    });
  }

  function scheduleRefresh(delay) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => {
      refreshAll(true).catch(() => {});
    }, delay || 400);
  }

  function handleWsEvent(payload) {
    if (!payload || !payload.type) return;
    const data = payload.data || {};
    switch (payload.type) {
      case "clarification:requested":
        upsertNotification({
          id: `clarification:${data.id || Date.now()}`,
          category: "attention",
          title: "Human decision required",
          body: data.question || data.blockingReason || "A worker needs clarification before proceeding.",
          meta: data.taskId ? `Task ${data.taskId}` : "Clarifications",
          actions: [
            { kind: "switch-view", label: "Open clarifications", view: "clarifications" },
            data.taskId ? { kind: "switch-view", label: "Open task", view: "tasks", taskId: data.taskId } : null,
          ].filter(Boolean),
          desktopAlert: true,
        });
        break;
      case "task:updated":
      case "task:completed":
      case "task:created": {
        const task = data || {};
        const status = String(task.status || "").toLowerCase();
        upsertNotification({
          id: `task:${task.id || task.taskId || Date.now()}`,
          category: status === "completed" ? "delivery" : ((status === "blocked" || status === "failed") ? "attention" : "active"),
          title: task.title || `Task ${task.id || ""}`,
          body: status === "completed" ? "Completed and ready for review." : `Now ${status || "updated"}.`,
          meta: [task.assignedRole, task.assignedWorkerId].filter(Boolean).join(" • "),
          actions: notificationActionsForTask(task.id || task.taskId || ""),
          desktopAlert: status === "completed" || status === "blocked" || status === "failed",
        });
        break;
      }
      case "report:ready":
        upsertNotification({
          id: `report:${data.reportUrl || Date.now()}`,
          category: "delivery",
          title: `${data.projectName || "Project"} delivery report`,
          body: "A completion report is ready.",
          meta: data.status || "completed",
          actions: [
            { kind: "open-report", label: "Open report", reportUrl: data.reportUrl || "" },
            { kind: "switch-view", label: "Open reports", view: "reports" },
          ],
          desktopAlert: true,
        });
        break;
      default:
        break;
    }
    scheduleRefresh(300);
  }

  function disconnectWs() {
    if (state.ws) {
      try { state.ws.close(); } catch { /* ignore */ }
      state.ws = null;
    }
  }

  function connectWs() {
    disconnectWs();
    if (!state.controllerUrl) return;
    const url = new URL(state.controllerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    const ws = new WebSocket(url.toString());
    state.ws = ws;
    setConnectionPill("connecting", "Connecting");
    ws.onopen = function () {
      setConnectionPill("connected", "Connected");
      setStatusLine(`Connected to ${state.controllerUrl}`);
    };
    ws.onmessage = function (event) {
      try {
        handleWsEvent(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
    };
    ws.onclose = function () {
      if (state.ws === ws) {
        setConnectionPill("disconnected", "Disconnected");
      }
    };
    ws.onerror = function () {
      setConnectionPill("disconnected", "Disconnected");
    };
  }

  async function refreshReports() {
    const data = await apiGet("/reports");
    state.reports = normalizeArray(data.reports).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
    renderReports();
  }

  async function refreshWorkspaceTree() {
    const data = await apiGet("/workspace/tree");
    state.workspaceTree = normalizeArray(data.entries);
    renderWorkspaceTree();
  }

  async function refreshAll(silent) {
    if (!state.controllerUrl) return;
    try {
      const [statusData, runsData, reportsData] = await Promise.all([
        apiGet("/team/status"),
        apiGet("/controller/runs"),
        apiGet("/reports"),
      ]);
      state.teamStatus = {
        tasks: normalizeArray(statusData.tasks).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        workers: normalizeArray(statusData.workers),
        clarifications: normalizeArray(statusData.clarifications).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        controllerRuns: normalizeArray(runsData.controllerRuns || statusData.controllerRuns).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        messages: normalizeArray(statusData.messages),
      };
      state.reports = normalizeArray(reportsData.reports).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
      if (!state.selectedPlanningRunId && state.teamStatus.controllerRuns.length > 0) {
        const withKickoff = state.teamStatus.controllerRuns.find((run) => run.manifest && run.manifest.kickoffPlan);
        if (withKickoff) state.selectedPlanningRunId = withKickoff.id;
      }
      renderMissionSummary();
      renderPlanning();
      renderTasks();
      renderClarifications();
      renderReports();
      updateNotificationsFromStatus();
      if (!state.workspaceTree.length) {
        refreshWorkspaceTree().catch(() => {});
      }
    } catch (error) {
      if (!silent) {
        setStatusLine(error instanceof Error ? error.message : "Failed to refresh controller state");
        setConnectionPill("disconnected", "Disconnected");
      }
      throw error;
    }
  }

  async function connectController(url, opts) {
    state.controllerUrl = normalizeBaseUrl(url);
    if (!state.controllerUrl) throw new Error("Controller URL is required");
    $("#controller-url").value = state.controllerUrl;
    state.settings = await desktop.saveSettings({ ...(state.settings || {}), controllerUrl: state.controllerUrl });
    await refreshAll(false);
    await refreshWorkspaceTree().catch(() => {});
    connectWs();
    setStatusLine(`Connected to ${state.controllerUrl}`);
    if (!(opts && opts.skipConversation)) {
      pushConversation("system", `Connected to controller ${state.controllerUrl}`);
    }
  }

  function renderPlanning() {
    const list = $("#planning-list");
    const detail = $("#planning-detail");
    if (!list || !detail) return;
    const runs = state.teamStatus.controllerRuns.filter((run) => run.manifest && run.manifest.kickoffPlan && Array.isArray(run.manifest.kickoffPlan.assessments));
    if (runs.length === 0) {
      list.innerHTML = '<div class="empty-state">No kickoff sessions yet.</div>';
      detail.innerHTML = '<div class="empty-state">No planning run selected.</div>';
      return;
    }
    if (!state.selectedPlanningRunId || !runs.some((run) => run.id === state.selectedPlanningRunId)) {
      state.selectedPlanningRunId = runs[0].id;
    }
    list.innerHTML = runs.map((run) => {
      const active = run.id === state.selectedPlanningRunId ? " active" : "";
      const roles = normalizeArray(run.manifest.requiredRoles).length;
      const title = run.manifest.requirementSummary || run.title || "Untitled";
      return `<button class="list-item${active}" data-planning-id="${escapeHtml(run.id)}" type="button"><div><strong>${escapeHtml(title)}</strong></div><div class="item-meta">${roles} roles • ${escapeHtml(formatDateTime(run.updatedAt))}</div></button>`;
    }).join("");
    const selected = runs.find((run) => run.id === state.selectedPlanningRunId);
    const manifest = selected.manifest || {};
    const kickoff = manifest.kickoffPlan || {};
    const assessments = normalizeArray(kickoff.assessments);
    detail.innerHTML = (
      `<div class="detail-block"><div class="detail-kicker">Requirement</div><div class="detail-title">${escapeHtml(manifest.requirementSummary || selected.title || "Planning run")}</div><div class="item-body">${nl2br(selected.request || "")}</div></div>` +
      `<div class="detail-block"><div class="detail-kicker">Roles</div><div class="pill-row">${normalizeArray(manifest.requiredRoles).map((role) => `<span class="mini-pill">${escapeHtml(role)}</span>`).join("")}</div></div>` +
      `<div class="detail-block"><div class="detail-kicker">Kickoff consensus</div>${kickoff.summary ? `<div class="item-body">${nl2br(kickoff.summary)}</div>` : '<div class="empty-state">No summary.</div>'}</div>` +
      `<div class="detail-block"><div class="detail-kicker">Role assessments</div>${assessments.map((item) => {
        return `<article class="list-item"><div><strong>${escapeHtml(item.role || "role")}</strong> ${item.needed ? '• needed' : '• optional'}</div><div class="item-body">${nl2br(item.scope || "No scope provided.")}</div>${Array.isArray(item.tasks) && item.tasks.length ? `<div class="pill-row">${item.tasks.map((task) => `<span class="mini-pill">${escapeHtml(task)}</span>`).join("")}</div>` : ""}</article>`;
      }).join("")}</div>`
    );
  }

  function renderTasks() {
    const list = $("#task-list");
    const detail = $("#task-detail");
    if (!list || !detail) return;
    const tasks = state.teamStatus.tasks.filter((task) => state.taskFilter === "all" || task.status === state.taskFilter);
    if (tasks.length === 0) {
      list.innerHTML = '<div class="empty-state">No tasks in this filter.</div>';
      detail.innerHTML = '<div class="empty-state">Select a task to inspect its timeline and execution.</div>';
      return;
    }
    if (!state.selectedTaskId || !tasks.some((task) => task.id === state.selectedTaskId)) {
      state.selectedTaskId = tasks[0].id;
    }
    list.innerHTML = tasks.map((task) => {
      const active = task.id === state.selectedTaskId ? " active" : "";
      return `<button type="button" class="list-item${active}" data-task-id="${escapeHtml(task.id)}"><div class="task-headline"><strong>${escapeHtml(task.title || task.id)}</strong></div><div class="item-meta">${escapeHtml(humanize(task.status))} • ${escapeHtml(task.assignedRole || "auto")} • ${escapeHtml(formatDateTime(task.updatedAt))}</div><div class="task-body">${nl2br(task.progress || task.description || "")}</div></button>`;
    }).join("");
    const selected = state.teamStatus.tasks.find((task) => task.id === state.selectedTaskId);
    if (selected) {
      renderTaskDetail(selected.id);
    }
  }

  async function renderTaskDetail(taskId) {
    const detail = $("#task-detail");
    if (!detail || !taskId) return;
    detail.innerHTML = '<div class="empty-state">Loading task detail…</div>';
    try {
      const data = await apiGet(`/tasks/${encodeURIComponent(taskId)}/execution`);
      const task = data.task || {};
      const messages = normalizeArray(data.messages);
      const clarifications = normalizeArray(data.clarifications);
      const events = normalizeArray(task.execution && task.execution.events).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      detail.innerHTML = (
        `<div class="detail-block"><div class="detail-kicker">Task</div><div class="detail-title">${escapeHtml(task.title || task.id || "Task")}</div><div class="detail-subtitle">${escapeHtml(humanize(task.status || "unknown"))} • ${escapeHtml(task.assignedRole || "auto")}</div><div class="item-body">${nl2br(task.description || "")}</div><div class="pill-row">${[task.priority, task.assignedWorkerId, task.assignedRole].filter(Boolean).map((v) => `<span class="mini-pill">${escapeHtml(v)}</span>`).join("")}</div></div>` +
        `<div class="detail-block"><div class="detail-kicker">Timeline</div><div class="timeline">${events.length ? events.map((event) => `<article class="timeline-entry"><div class="timeline-head"><strong>${escapeHtml(humanize(event.type || event.phase || "event"))}</strong><span class="entry-meta">${escapeHtml(formatDateTime(event.createdAt))}</span></div><div class="item-body">${nl2br(event.message || "")}</div></article>`).join("") : '<div class="empty-state">No execution events yet.</div>'}</div></div>` +
        `<div class="detail-block"><div class="detail-kicker">Messages</div>${messages.length ? messages.map((message) => `<article class="timeline-entry"><div class="timeline-head"><strong>${escapeHtml(message.from || "message")}</strong><span class="entry-meta">${escapeHtml(formatDateTime(message.createdAt))}</span></div><div class="item-body">${nl2br(message.content || "")}</div></article>`).join("") : '<div class="empty-state">No task-linked messages.</div>'}</div>` +
        `<div class="detail-block"><div class="detail-kicker">Clarifications</div>${clarifications.length ? clarifications.map((item) => `<article class="timeline-entry"><div class="timeline-head"><strong>${escapeHtml(item.status || 'pending')}</strong><span class="entry-meta">${escapeHtml(formatDateTime(item.updatedAt || item.createdAt))}</span></div><div class="item-body">${nl2br(item.question || '')}</div>${item.answer ? `<div class="item-body">Answer: ${nl2br(item.answer)}</div>` : ''}</article>`).join("") : '<div class="empty-state">No clarification history.</div>'}</div>`
      );
    } catch (error) {
      detail.innerHTML = `<div class="empty-state">${escapeHtml(error instanceof Error ? error.message : 'Failed to load task detail')}</div>`;
    }
  }

  function renderClarifications() {
    const list = $("#clarification-list");
    if (!list) return;
    const items = state.teamStatus.clarifications;
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-state">No clarifications right now.</div>';
      return;
    }
    list.innerHTML = items.map((item) => {
      const answered = !!item.answer;
      return (
        `<article class="clarification-card">` +
        `<div class="item-meta">${escapeHtml(item.taskId || 'task')} • ${escapeHtml(formatDateTime(item.updatedAt || item.createdAt))}</div>` +
        `<div class="clarification-body"><strong>Question:</strong><br>${nl2br(item.question || '')}</div>` +
        `<div class="clarification-body"><strong>Why blocked:</strong><br>${nl2br(item.blockingReason || '')}</div>` +
        (item.context ? `<div class="clarification-body"><strong>Context:</strong><br>${nl2br(item.context)}</div>` : '') +
        (answered ? `<div class="clarification-body"><strong>Answer:</strong><br>${nl2br(item.answer)}</div>` : `<textarea data-clarification-answer="${escapeHtml(item.id)}" placeholder="Type the human answer here…"></textarea><div class="inline-actions"><button class="inline-action" type="button" data-clarification-submit="${escapeHtml(item.id)}">Send answer</button><button class="inline-action" type="button" data-clarification-open-task="${escapeHtml(item.taskId || '')}">Open task</button></div>`) +
        `</article>`
      );
    }).join("");
  }

  function renderWorkspaceTree() {
    const el = $("#workspace-tree");
    if (!el) return;
    if (!state.workspaceTree.length) {
      el.innerHTML = '<div class="empty-state">No workspace entries yet.</div>';
      return;
    }
    el.innerHTML = renderWorkspaceNodes(state.workspaceTree, 0);
  }

  function renderWorkspaceNodes(nodes, depth) {
    const cls = depth === 0 ? "tree-root" : "tree-children";
    return `<ul class="${cls}">${(nodes || []).map((node) => {
      if (node.type === 'directory') {
        const lazy = !Array.isArray(node.children);
        return `<li class="tree-node"><div class="tree-row" data-tree-dir="${escapeHtml(node.path)}" data-lazy="${lazy ? '1' : '0'}"><span>${lazy ? '▸' : '▾'}</span><strong>${escapeHtml(node.name)}</strong></div>${Array.isArray(node.children) ? renderWorkspaceNodes(node.children, depth + 1) : '<ul class="tree-children" style="display:none"></ul>'}</li>`;
      }
      const active = node.path === state.selectedWorkspacePath ? ' active' : '';
      return `<li class="tree-node"><div class="tree-row${active}" data-tree-file="${escapeHtml(node.path)}"><span>•</span><span>${escapeHtml(node.name)}</span></div></li>`;
    }).join('')}</ul>`;
  }

  function findWorkspaceNode(nodes, path) {
    for (const node of (nodes || [])) {
      if (node.path === path) return node;
      if (node.type === 'directory' && Array.isArray(node.children)) {
        const found = findWorkspaceNode(node.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  function mergeWorkspaceChildren(path, entries) {
    const node = findWorkspaceNode(state.workspaceTree, path);
    if (node && node.type === 'directory') {
      node.children = entries;
    }
  }

  async function loadWorkspaceFile(path) {
    const data = await apiGet(`/workspace/file?path=${encodeURIComponent(path)}`);
    state.selectedWorkspacePath = path;
    state.selectedWorkspaceFile = data.file || null;
    state.workspaceView = (state.selectedWorkspaceFile && (state.selectedWorkspaceFile.previewType === 'markdown' || state.selectedWorkspaceFile.previewType === 'html')) ? 'preview' : 'source';
    renderWorkspaceTree();
    renderWorkspaceContent();
  }

  function renderWorkspaceContent() {
    const nameEl = $("#workspace-file-name");
    const metaEl = $("#workspace-file-meta");
    const contentEl = $("#workspace-content");
    if (!contentEl || !nameEl || !metaEl) return;
    const file = state.selectedWorkspaceFile;
    $$(".seg-btn").forEach((btn) => btn.classList.toggle('active', btn.id === `workspace-view-${state.workspaceView}`));
    if (!file) {
      nameEl.textContent = 'Select a file';
      metaEl.textContent = '';
      contentEl.innerHTML = '<div class="empty-state">Select a workspace file to inspect it.</div>';
      return;
    }
    nameEl.textContent = file.name || file.path;
    metaEl.textContent = `${file.path} • ${formatBytes(file.size)} • ${humanize(file.previewType)}`;
    if (state.workspaceView === 'preview' && file.previewType === 'html') {
      contentEl.innerHTML = `<div class="preview-shell"><iframe src="${escapeHtml(`${state.controllerUrl}${file.rawUrl}`)}"></iframe></div>`;
      return;
    }
    if (state.workspaceView === 'preview' && file.previewType === 'markdown') {
      contentEl.innerHTML = `<div class="preview-shell">${nl2br(file.content || '')}</div>`;
      return;
    }
    contentEl.innerHTML = `<div class="file-shell">${nl2br(file.content || '')}</div>`;
  }

  function renderReports() {
    const list = $("#report-list");
    if (!list) return;
    if (!state.reports.length) {
      list.innerHTML = '<div class="empty-state">No delivery reports yet.</div>';
      return;
    }
    list.innerHTML = state.reports.map((report) => {
      return (
        `<article class="report-card">` +
        `  <div><strong>${escapeHtml(report.projectName || report.requirementSummary || report.sessionKey || 'Report')}</strong></div>` +
        `  <div class="report-meta">${escapeHtml(report.status || 'completed')} • ${escapeHtml(formatDateTime(report.generatedAt))}</div>` +
        `  <div class="report-body">${nl2br(report.requirementSummary || '')}</div>` +
        `  <div class="report-actions"><button class="inline-action" type="button" data-open-report="${escapeHtml(report.sessionKey || '')}">Open report</button></div>` +
        `</article>`
      );
    }).join('');
  }

  function renderLocalController() {
    const box = $("#local-log");
    const payload = state.localController;
    if (!payload) {
      setLocalPill('stopped', 'Idle');
      if (box) box.textContent = 'No local controller activity yet.';
      return;
    }
    setLocalPill(payload.running ? 'running' : 'stopped', payload.running ? 'Running' : 'Stopped');
    const lines = Array.isArray(payload.logLines) ? payload.logLines.slice(-25) : [];
    box.textContent = lines.length ? lines.map((entry) => `[${entry.stream}] ${entry.line}`).join('\n') : (payload.running ? 'Controller started. Waiting for logs…' : 'Controller stopped.');
    box.scrollTop = box.scrollHeight;
  }

  function activateView(view) {
    state.currentView = view || 'mission';
    $$('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === state.currentView));
    $$('.stage-view').forEach((pane) => pane.classList.toggle('active', pane.id === `view-${state.currentView}`));
  }

  async function submitComposer() {
    const input = $("#composer-input");
    const text = String(input && input.value || '').trim();
    if (!text || !state.controllerUrl) return;
    pushConversation('human', text);
    input.value = '';
    try {
      const data = await apiPost('/controller/intake', { message: text, sessionKey: state.sessionKey });
      pushConversation('controller', data.reply || 'Controller completed without a textual reply.');
      scheduleRefresh(250);
    } catch (error) {
      pushConversation('controller', error instanceof Error ? error.message : 'Failed to send requirement');
    }
  }

  async function answerClarification(id) {
    const textarea = document.querySelector(`[data-clarification-answer="${CSS.escape(id)}"]`);
    const answer = textarea ? textarea.value.trim() : '';
    if (!answer) return;
    try {
      await apiPost(`/clarifications/${encodeURIComponent(id)}/answer`, { answer, answeredBy: 'human-desktop' });
      scheduleRefresh(200);
    } catch (error) {
      setStatusLine(error instanceof Error ? error.message : 'Failed to answer clarification');
    }
  }

  async function connectSavedController() {
    state.settings = await desktop.getSettings();
    state.localController = await desktop.getLocalControllerStatus();
    renderLocalController();
    $('#controller-url').value = state.settings.controllerUrl || '';
    $('#local-command').value = state.settings.localControllerCommand || '';
    $('#local-cwd').value = state.settings.localControllerCwd || '';
    $('#local-url').value = state.settings.localControllerUrl || '';
    if (state.settings.controllerUrl) {
      try {
        await connectController(state.settings.controllerUrl, { skipConversation: true });
      } catch (error) {
        setStatusLine(error instanceof Error ? error.message : 'Failed to connect');
      }
    }
  }

  $('#connect-btn').addEventListener('click', function () {
    connectController($('#controller-url').value).catch((error) => {
      setStatusLine(error instanceof Error ? error.message : 'Failed to connect');
    });
  });
  $('#refresh-btn').addEventListener('click', function () {
    refreshAll(false).catch((error) => setStatusLine(error instanceof Error ? error.message : 'Refresh failed'));
    refreshWorkspaceTree().catch(() => {});
  });
  $('#compose-focus-btn').addEventListener('click', function () {
    activateView('mission');
    $('#composer-input').focus();
  });
  $('#composer-send').addEventListener('click', submitComposer);
  $('#start-local-btn').addEventListener('click', async function () {
    state.settings = await desktop.saveSettings({
      ...(state.settings || {}),
      localControllerCommand: $('#local-command').value,
      localControllerCwd: $('#local-cwd').value,
      localControllerUrl: $('#local-url').value,
      controllerUrl: $('#local-url').value,
    });
    state.localController = await desktop.startLocalController({ command: $('#local-command').value, cwd: $('#local-cwd').value });
    renderLocalController();
    setTimeout(() => {
      connectController($('#local-url').value, { skipConversation: true }).catch(() => {
        setStatusLine('Local controller started; waiting for HTTP API to come up…');
      });
    }, 2500);
  });
  $('#stop-local-btn').addEventListener('click', async function () {
    state.localController = await desktop.stopLocalController();
    renderLocalController();
  });
  $('#workspace-view-source').addEventListener('click', function () { state.workspaceView = 'source'; renderWorkspaceContent(); });
  $('#workspace-view-preview').addEventListener('click', function () {
    if (!state.selectedWorkspaceFile) return;
    if (state.selectedWorkspaceFile.previewType === 'markdown' || state.selectedWorkspaceFile.previewType === 'html') {
      state.workspaceView = 'preview';
      renderWorkspaceContent();
    }
  });

  document.addEventListener('click', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const nav = target.closest('[data-view]');
    if (nav && nav.classList.contains('nav-btn')) {
      activateView(nav.dataset.view || 'mission');
      return;
    }

    const filter = target.closest('[data-task-filter]');
    if (filter) {
      state.taskFilter = filter.dataset.taskFilter || 'all';
      $$('[data-task-filter]').forEach((btn) => btn.classList.toggle('active', btn.dataset.taskFilter === state.taskFilter));
      renderTasks();
      return;
    }

    const nfilter = target.closest('[data-notice-filter]');
    if (nfilter) {
      state.noticeFilter = nfilter.dataset.noticeFilter || 'all';
      $$('[data-notice-filter]').forEach((btn) => btn.classList.toggle('active', btn.dataset.noticeFilter === state.noticeFilter));
      renderNotifications();
      return;
    }

    const planning = target.closest('[data-planning-id]');
    if (planning) {
      state.selectedPlanningRunId = planning.dataset.planningId || '';
      renderPlanning();
      return;
    }

    const taskBtn = target.closest('[data-task-id]');
    if (taskBtn && taskBtn.classList.contains('list-item')) {
      state.selectedTaskId = taskBtn.dataset.taskId || '';
      renderTasks();
      return;
    }

    const submitClarification = target.closest('[data-clarification-submit]');
    if (submitClarification) {
      answerClarification(submitClarification.dataset.clarificationSubmit || '');
      return;
    }

    const openClarificationTask = target.closest('[data-clarification-open-task]');
    if (openClarificationTask) {
      activateView('tasks');
      state.selectedTaskId = openClarificationTask.dataset.clarificationOpenTask || '';
      renderTasks();
      return;
    }

    const treeFile = target.closest('[data-tree-file]');
    if (treeFile) {
      loadWorkspaceFile(treeFile.dataset.treeFile || '').catch((error) => setStatusLine(error instanceof Error ? error.message : 'Failed to load file'));
      return;
    }

    const treeDir = target.closest('[data-tree-dir]');
    if (treeDir) {
      const row = treeDir;
      const container = row.parentElement.querySelector(':scope > .tree-children');
      if (!container) return;
      const hidden = container.style.display === 'none';
      if (hidden) {
        container.style.display = '';
        row.firstElementChild.textContent = '▾';
        if (row.dataset.lazy === '1') {
          row.dataset.lazy = '0';
          container.innerHTML = '<li class="tree-node"><div class="empty-state">Loading…</div></li>';
          apiGet(`/workspace/subtree?path=${encodeURIComponent(row.dataset.treeDir || '')}`).then((data) => {
            const entries = normalizeArray(data.entries);
            mergeWorkspaceChildren(row.dataset.treeDir || '', entries);
            container.outerHTML = renderWorkspaceNodes(entries, 1).replace('tree-root', 'tree-children');
          }).catch((error) => {
            container.innerHTML = `<li class="tree-node"><div class="empty-state">${escapeHtml(error instanceof Error ? error.message : 'Failed to load directory')}</div></li>`;
          });
        }
      } else {
        container.style.display = 'none';
        row.firstElementChild.textContent = '▸';
      }
      return;
    }

    const openReport = target.closest('[data-open-report]');
    if (openReport) {
      desktop.openExternal(`${state.controllerUrl}/api/v1/reports/${encodeURIComponent(openReport.dataset.openReport || '')}`);
      return;
    }

    const notice = target.closest('[data-notice-action]');
    if (notice) {
      const action = notice.dataset.noticeAction || '';
      if (action === 'switch-view') {
        if (notice.dataset.view) activateView(notice.dataset.view);
        if (notice.dataset.taskId) {
          state.selectedTaskId = notice.dataset.taskId;
          renderTasks();
        }
        if (notice.dataset.runId) {
          state.selectedPlanningRunId = notice.dataset.runId;
          renderPlanning();
        }
      }
      if (action === 'open-report' && notice.dataset.reportUrl) {
        desktop.openExternal(`${state.controllerUrl}${notice.dataset.reportUrl}`);
      }
    }
  });

  desktop.onLocalControllerEvent(function (payload) {
    if (payload && payload.payload) {
      state.localController = payload.payload;
      renderLocalController();
    }
  });

  connectSavedController();
  renderConversation();
  activateView('mission');
  setInterval(() => {
    if (state.controllerUrl) refreshAll(true).catch(() => {});
  }, 15000);
})();
