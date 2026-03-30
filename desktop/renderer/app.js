(function () {
  "use strict";

  const desktop = window.teamclawDesktop;
  const state = {
    settings: null,
    controllerUrl: "",
    ws: null,
    notifications: [],
    notificationFilter: "all",
    summary: null,
    localController: null,
  };

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  function normalizeBaseUrl(input) {
    const raw = String(input || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `http://${raw}`;
  }

  function formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString();
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value == null ? "" : value);
    return div.innerHTML;
  }

  function controllerApi(path) {
    return `${state.controllerUrl}/api/v1${path}`;
  }

  function controllerUi(params) {
    const url = new URL(`${state.controllerUrl}/ui`);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value) {
        url.searchParams.set(key, String(value));
      }
    });
    return url.toString();
  }

  function controllerWsUrl() {
    const url = new URL(state.controllerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    return url.toString();
  }

  function setConnectionPill(kind, text) {
    const pill = $("#connection-pill");
    if (!pill) return;
    pill.className = `pill pill-${kind}`;
    pill.textContent = text;
  }

  function setLocalPill(kind, text) {
    const pill = $("#local-pill");
    if (!pill) return;
    pill.className = `pill pill-${kind}`;
    pill.textContent = text;
  }

  function setStatusLine(text) {
    const el = $("#status-line");
    if (el) el.textContent = text;
  }

  function setSummaryLine(text) {
    const el = $("#summary-line");
    if (el) el.textContent = text;
  }

  function renderLocalController() {
    const box = $("#local-log");
    const payload = state.localController;
    if (!payload) {
      setLocalPill("stopped", "Idle");
      if (box) box.textContent = "No local controller activity yet.";
      return;
    }
    setLocalPill(payload.running ? "running" : "stopped", payload.running ? "Running" : "Stopped");
    if (!box) return;
    const lines = Array.isArray(payload.logLines) ? payload.logLines.slice(-20) : [];
    if (lines.length === 0) {
      box.textContent = payload.running ? "Controller started. Waiting for logs…" : "Controller stopped.";
      return;
    }
    box.innerHTML = lines.map((entry) => {
      return `<div>[${escapeHtml(entry.stream)}] ${escapeHtml(entry.line)}</div>`;
    }).join("");
    box.scrollTop = box.scrollHeight;
  }

  function upsertNotification(item) {
    const existing = state.notifications.find((entry) => entry.id === item.id);
    const isNew = !existing;
    if (existing) {
      Object.assign(existing, item, { count: (existing.count || 1) + 1, updatedAt: Date.now() });
    } else {
      state.notifications.unshift({
        count: 1,
        updatedAt: Date.now(),
        ...item,
      });
    }
    state.notifications.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    state.notifications = state.notifications.slice(0, 80);
    renderNotifications();
    if (isNew && item.desktopAlert) {
      desktop.showNotification({
        title: item.title,
        body: item.body,
      });
    }
  }

  function summarizeStatus(status) {
    const tasks = Array.isArray(status.tasks) ? status.tasks : Object.values(status.tasks || {});
    const clarifications = Array.isArray(status.clarifications) ? status.clarifications : Object.values(status.clarifications || {});
    const workers = Array.isArray(status.workers) ? status.workers : Object.values(status.workers || {});
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
    };
  }

  function renderSummary(status) {
    state.summary = summarizeStatus(status);
    $("#attention-count").textContent = String(state.summary.blocked);
    $("#active-count").textContent = String(state.summary.active);
    $("#delivery-count").textContent = String(state.summary.completed);
    setSummaryLine(
      `${state.summary.workers} workers • ${state.summary.pending} pending • ${state.summary.active} in flight • ${state.summary.completed} completed`
    );
  }

  async function fetchStatus() {
    if (!state.controllerUrl) return;
    const response = await fetch(controllerApi("/team/status"));
    if (!response.ok) {
      throw new Error(`Controller returned ${response.status}`);
    }
    const data = await response.json();
    renderSummary(data || {});
    const clarifications = Array.isArray(data.clarifications) ? data.clarifications : Object.values(data.clarifications || {});
    clarifications.filter((item) => !item.answer).forEach((item) => {
      upsertNotification({
        id: `clarification:${item.id || item.taskId || item.createdAt}`,
        category: "attention",
        title: "Clarification needed",
        body: item.question || item.blockingReason || "A worker is waiting for human input.",
        meta: item.taskId ? `Task ${item.taskId}` : "Controller",
        actions: [
          { kind: "navigate", label: "Open clarifications", tab: "clarifications" },
          item.taskId ? { kind: "navigate", label: "Open task", tab: "tasks", taskId: item.taskId } : null,
        ].filter(Boolean),
        desktopAlert: false,
      });
    });
  }

  function renderNotifications() {
    const list = $("#notification-list");
    if (!list) return;
    const filtered = state.notifications.filter((item) => {
      return state.notificationFilter === "all" || item.category === state.notificationFilter;
    });
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state">No notifications for this view yet.</div>';
      return;
    }
    list.innerHTML = filtered.map((item) => {
      const actions = Array.isArray(item.actions) ? item.actions : [];
      const meta = [item.meta, item.count > 1 ? `${item.count} updates` : null, formatTime(item.updatedAt)].filter(Boolean).join(" • ");
      return (
        `<article class="notification-card ${escapeHtml(item.category || "active")}">` +
        `  <div class="notification-head">` +
        `    <div class="notification-title">${escapeHtml(item.title)}</div>` +
        `    <div class="notification-meta">${escapeHtml(meta)}</div>` +
        `  </div>` +
        `  <div class="notification-body">${escapeHtml(item.body)}</div>` +
        `  <div class="notification-actions">` +
        actions.map((action) => {
          return `<button type="button" data-action="${escapeHtml(action.kind)}" data-tab="${escapeHtml(action.tab || "")}" data-task-id="${escapeHtml(action.taskId || "")}" data-report-url="${escapeHtml(action.reportUrl || "")}" data-planning-run="${escapeHtml(action.planningRun || "")}">${escapeHtml(action.label)}</button>`;
        }).join("") +
        `  </div>` +
        `</article>`
      );
    }).join("");
  }

  function makeActionsForTask(taskId) {
    return [
      { kind: "navigate", label: "Open task", tab: "tasks", taskId },
      { kind: "navigate", label: "Open tasks board", tab: "tasks" },
    ];
  }

  function handleControllerEvent(payload) {
    if (!payload || !payload.type) return;
    const data = payload.data || {};
    switch (payload.type) {
      case "clarification:requested":
        upsertNotification({
          id: `clarification:${data.id || data.taskId || Date.now()}`,
          category: "attention",
          title: "Human decision required",
          body: data.question || data.blockingReason || "A worker needs clarification before proceeding.",
          meta: data.taskId ? `Task ${data.taskId}` : "Clarifications",
          desktopAlert: true,
          actions: [
            { kind: "navigate", label: "Open clarifications", tab: "clarifications" },
            data.taskId ? { kind: "navigate", label: "Open task", tab: "tasks", taskId: data.taskId } : null,
          ].filter(Boolean),
        });
        break;
      case "task:updated":
      case "task:completed": {
        const task = data || {};
        const status = String(task.status || "").toLowerCase();
        const category = status === "failed" || status === "blocked"
          ? "attention"
          : (status === "completed" ? "delivery" : "active");
        upsertNotification({
          id: `task:${task.id || task.taskId || Date.now()}`,
          category,
          title: task.title || `Task ${task.id || ""}`.trim(),
          body: status === "completed"
            ? "Completed and ready for review."
            : (status === "blocked" ? "Blocked and needs intervention." : `Now ${status || "updated"}.`),
          meta: [task.assignedRole || null, task.assignedWorkerId || null].filter(Boolean).join(" • "),
          desktopAlert: status === "completed" || status === "failed" || status === "blocked",
          actions: makeActionsForTask(task.id || task.taskId || ""),
        });
        break;
      }
      case "report:ready":
        upsertNotification({
          id: `report:${data.reportUrl || Date.now()}`,
          category: "delivery",
          title: `${data.projectName || "Project"} delivery report`,
          body: "A completion report is ready to open or share.",
          meta: data.status || "completed",
          desktopAlert: true,
          actions: [
            { kind: "open-report", label: "Open report", reportUrl: data.reportUrl || "" },
            { kind: "navigate", label: "Open messages", tab: "messages" },
          ],
        });
        break;
      default:
        break;
    }
  }

  function disconnectWs() {
    if (state.ws) {
      try {
        state.ws.close();
      } catch {
        // ignore
      }
      state.ws = null;
    }
  }

  function connectWs() {
    disconnectWs();
    if (!state.controllerUrl) return;
    setConnectionPill("connecting", "Connecting");
    const ws = new WebSocket(controllerWsUrl());
    state.ws = ws;
    ws.onopen = () => {
      setConnectionPill("connected", "Connected");
      setStatusLine(`Connected to ${state.controllerUrl}`);
    };
    ws.onmessage = (event) => {
      try {
        handleControllerEvent(JSON.parse(event.data));
      } catch {
        // ignore malformed events
      }
    };
    ws.onclose = () => {
      if (state.ws === ws) {
        setConnectionPill("disconnected", "Disconnected");
        setStatusLine(`Disconnected from ${state.controllerUrl}`);
      }
    };
    ws.onerror = () => {
      setConnectionPill("disconnected", "Disconnected");
    };
  }

  function mountWebview(url) {
    const webview = $("#controller-webview");
    const empty = $("#webview-empty");
    if (!webview || !empty) return;
    webview.src = url;
    webview.classList.add("connected");
    empty.classList.add("hidden");
  }

  async function connectController(url, options) {
    state.controllerUrl = normalizeBaseUrl(url);
    if (!state.controllerUrl) {
      throw new Error("Controller URL is required");
    }
    $("#controller-url").value = state.controllerUrl;
    mountWebview(controllerUi({}));
    connectWs();
    await fetchStatus();
    setStatusLine(`Connected to ${state.controllerUrl}`);
    if (!(options && options.skipSave)) {
      state.settings = await desktop.saveSettings({
        ...state.settings,
        controllerUrl: state.controllerUrl,
      });
    }
  }

  function navigateWebview(tab, extra) {
    if (!state.controllerUrl) return;
    mountWebview(controllerUi({
      tab,
      taskId: extra?.taskId,
      planningRun: extra?.planningRun,
    }));
  }

  async function loadInitialState() {
    state.settings = await desktop.getSettings();
    $("#controller-url").value = state.settings.controllerUrl || "";
    $("#local-command").value = state.settings.localControllerCommand || "";
    $("#local-cwd").value = state.settings.localControllerCwd || "";
    $("#local-url").value = state.settings.localControllerUrl || "";
    state.localController = await desktop.getLocalControllerStatus();
    renderLocalController();
    if (state.settings.controllerUrl) {
      try {
        await connectController(state.settings.controllerUrl, { skipSave: true });
      } catch (error) {
        setConnectionPill("disconnected", "Disconnected");
        setStatusLine(error instanceof Error ? error.message : "Failed to connect");
      }
    }
  }

  $("#connect-btn").addEventListener("click", async function () {
    try {
      await connectController($("#controller-url").value);
    } catch (error) {
      setConnectionPill("disconnected", "Disconnected");
      setStatusLine(error instanceof Error ? error.message : "Failed to connect");
    }
  });

  $("#open-browser-btn").addEventListener("click", function () {
    if (!state.controllerUrl) return;
    desktop.openExternal(controllerUi({}));
  });

  $("#start-local-btn").addEventListener("click", async function () {
    const payload = {
      command: $("#local-command").value,
      cwd: $("#local-cwd").value,
    };
    state.settings = await desktop.saveSettings({
      ...state.settings,
      localControllerCommand: $("#local-command").value,
      localControllerCwd: $("#local-cwd").value,
      localControllerUrl: $("#local-url").value,
      controllerUrl: $("#local-url").value,
    });
    state.localController = await desktop.startLocalController(payload);
    renderLocalController();
    setTimeout(() => {
      connectController($("#local-url").value).catch(() => {
        setStatusLine("Local controller started; waiting for API to come up…");
      });
    }, 2500);
  });

  $("#stop-local-btn").addEventListener("click", async function () {
    state.localController = await desktop.stopLocalController();
    renderLocalController();
  });

  $("#focus-planning-btn").addEventListener("click", function () { navigateWebview("planning"); });
  $("#focus-clarifications-btn").addEventListener("click", function () { navigateWebview("clarifications"); });
  $("#focus-tasks-btn").addEventListener("click", function () { navigateWebview("tasks"); });

  $$(".filter").forEach((button) => {
    button.addEventListener("click", function () {
      $$(".filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.notificationFilter = button.dataset.filter || "all";
      renderNotifications();
    });
  });

  $("#notification-list").addEventListener("click", function (event) {
    const target = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
    if (!target) return;
    const action = target.dataset.action || "";
    if (action === "navigate") {
      navigateWebview(target.dataset.tab || "tasks", {
        taskId: target.dataset.taskId || "",
        planningRun: target.dataset.planningRun || "",
      });
      return;
    }
    if (action === "open-report") {
      if (state.controllerUrl && target.dataset.reportUrl) {
        desktop.openExternal(`${state.controllerUrl}${target.dataset.reportUrl}`);
      }
    }
  });

  desktop.onLocalControllerEvent(function (event) {
    state.localController = event && event.payload ? event.payload : state.localController;
    renderLocalController();
  });

  loadInitialState();
  setInterval(() => {
    if (state.controllerUrl) {
      fetchStatus().catch(() => {});
    }
  }, 15000);
})();
