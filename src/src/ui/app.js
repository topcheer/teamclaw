// TeamClaw Web UI
(function () {
  "use strict";

  const API_BASE = "/api/v1";
  let ws = null;
  let currentFilter = "all";
  let teamState = { workers: [], tasks: [], messages: [] };

  // ==================== DOM Helpers ====================

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ==================== API ====================

  async function apiGet(path) {
    const res = await fetch(API_BASE + path);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ==================== WebSocket ====================

  function connectWebSocket() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${location.host}/ws`;

    setStatus("connecting");
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      setStatus("connected");
    };

    ws.onclose = function () {
      setStatus("disconnected");
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = function () {
      ws.close();
    };

    ws.onmessage = function (event) {
      try {
        const msg = JSON.parse(event.data);
        handleWsEvent(msg);
      } catch (e) {
        console.error("Invalid WS message:", event.data);
      }
    };
  }

  function setStatus(status) {
    const dot = $("#connection-status");
    dot.className = "status-dot " + status;
  }

  function handleWsEvent(event) {
    switch (event.type) {
      case "worker:online":
      case "worker:offline":
      case "task:created":
      case "task:updated":
      case "task:completed":
      case "message:new":
        refreshAll();
        break;
    }
  }

  // ==================== Rendering ====================

  async function refreshAll() {
    try {
      const [statusRes, rolesRes] = await Promise.all([
        apiGet("/team/status"),
        apiGet("/roles"),
      ]);

      teamState = statusRes;
      renderWorkers(statusRes.workers || []);
      renderTasks(statusRes.tasks || []);
      renderMessages(statusRes.messages || []);
      renderRoles(rolesRes.roles || []);
      $("#team-name").textContent = statusRes.teamName || "Team";
    } catch (err) {
      console.error("Failed to refresh:", err);
    }
  }

  function renderWorkers(workers) {
    const container = $("#workers-list");
    if (workers.length === 0) {
      container.innerHTML = '<div class="empty-state">No workers connected</div>';
      return;
    }

    container.innerHTML = workers.map(function (w) {
      return (
        '<div class="worker-card">' +
        '  <span class="worker-icon">' + escapeHtml(w.label || w.role).charAt(0) + '</span>' +
        '  <span class="worker-label">' + escapeHtml(w.label || w.role) + '</span>' +
        '  <span class="worker-status ' + (w.status || "offline") + '">' + (w.status || "offline") + '</span>' +
        '</div>'
      );
    }).join("");
  }

  function renderTasks(tasks) {
    var container = $("#tasks-board");
    var filtered = currentFilter === "all"
      ? tasks
      : tasks.filter(function (t) { return t.status === currentFilter; });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">No tasks' +
        (currentFilter !== "all" ? ' with status "' + currentFilter + '"' : "") + "</div>";
      return;
    }

    container.innerHTML = filtered.map(function (t) {
      var priority = t.priority || "medium";
      var status = t.status || "pending";
      var assignee = t.assignedWorkerId
        ? "Assigned to " + t.assignedWorkerId.slice(0, 8)
        : (t.assignedRole ? "Role: " + t.assignedRole : "Unassigned");

      return (
        '<div class="task-card">' +
        '  <span class="task-priority ' + priority + '">' + priority + "</span>" +
        '  <div class="task-body">' +
        '    <div class="task-title">' + escapeHtml(t.title) + "</div>" +
        (t.description ? '<div class="task-desc">' + escapeHtml(t.description).slice(0, 120) + "</div>" : "") +
        '    <div class="task-meta">' +
        '      <span class="task-status-badge ' + status + '">' + status.replace("_", " ") + "</span>" +
        "      <span>" + assignee + "</span>" +
        "      <span>" + formatTime(t.updatedAt) + "</span>" +
        "    </div>" +
        "  </div>" +
        "</div>"
      );
    }).join("");
  }

  function renderMessages(messages) {
    var container = $("#messages-feed");
    var recent = messages.slice(-50).reverse();

    if (recent.length === 0) {
      container.innerHTML = '<div class="empty-state">No messages yet</div>';
      return;
    }

    container.innerHTML = recent.map(function (m) {
      var from = m.fromRole || m.from || "unknown";
      var type = m.type || "direct";

      return (
        '<div class="message-card">' +
        '  <div class="message-header">' +
        '    <span class="message-from">' + escapeHtml(from) + "</span>" +
        '    <span class="message-type ' + type + '">' + type.replace("-", " ") + "</span>" +
        "  </div>" +
        '  <div class="message-content">' + escapeHtml(m.content) + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function renderRoles(roles) {
    var container = $("#roles-list");
    container.innerHTML = roles.map(function (r) {
      return (
        '<div class="role-chip">' +
        "  <span>" + (r.icon || "") + "</span>" +
        "  <span>" + escapeHtml(r.label) + "</span>" +
        "</div>"
      );
    }).join("");
  }

  function formatTime(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var h = String(d.getHours()).padStart(2, "0");
    var m = String(d.getMinutes()).padStart(2, "0");
    var s = String(d.getSeconds()).padStart(2, "0");
    return h + ":" + m + ":" + s;
  }

  // ==================== Event Handlers ====================

  // Tab switching
  $$(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      $$(".tab").forEach(function (t) { t.classList.remove("active"); });
      $$(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      var panel = $("#tab-" + tab.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });

  // Task filters
  $$(".filter-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      $$(".filter-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderTasks(teamState.tasks || []);
    });
  });

  // Create task form
  var taskForm = $("#create-task-form");
  if (taskForm) {
    taskForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      var title = $("#task-title").value.trim();
      var desc = $("#task-desc").value.trim();
      var priority = $("#task-priority").value;
      var role = $("#task-role").value;

      if (!title || !desc) return;

      try {
        var body = { title: title, description: desc, priority: priority, createdBy: "boss" };
        if (role) body.assignedRole = role;

        await apiPost("/tasks", body);
        taskForm.reset();
        refreshAll();
      } catch (err) {
        console.error("Failed to create task:", err);
      }
    });
  }

  // Command bar
  var cmdInput = $("#command-input");
  var cmdSend = $("#command-send");

  function handleCommand() {
    var cmd = (cmdInput.value || "").trim();
    if (!cmd) return;
    cmdInput.value = "";

    if (cmd === "/status" || cmd === "/s") {
      refreshAll();
      return;
    }

    if (cmd.startsWith("/assign ")) {
      var parts = cmd.split(" ");
      var taskId = parts[1];
      var role = parts[2];
      if (taskId && role) {
        apiPost("/tasks/" + taskId + "/assign", { targetRole: role })
          .then(function () { refreshAll(); })
          .catch(function (err) { console.error(err); });
      }
      return;
    }

    // Broadcast as message
    apiPost("/messages/broadcast", {
      from: "boss",
      content: cmd,
    }).then(function () { refreshAll(); });
  }

  if (cmdSend) {
    cmdSend.addEventListener("click", handleCommand);
  }

  if (cmdInput) {
    cmdInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") handleCommand();
    });
  }

  // ==================== Init ====================

  refreshAll();
  connectWebSocket();
})();
