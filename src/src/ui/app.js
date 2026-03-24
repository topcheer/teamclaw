// TeamClaw Web UI
(function () {
  "use strict";

  const API_BASE = "/api/v1";
  let ws = null;
  let currentFilter = "all";
  let activeTab = "tasks";
  let teamState = { workers: [], tasks: [], controllerRuns: [], messages: [], clarifications: [] };
  let selectedTaskId = null;
  let selectedTaskDetail = null;
  let selectedTaskDetailTab = "overview";
  let followTaskOutput = true;
  let workspaceTree = [];
  let selectedWorkspacePath = null;
  let selectedWorkspaceFile = null;
  let selectedWorkspaceView = "source";
  let workspaceLoaded = false;
  const CONTROLLER_SESSION_STORAGE_KEY = "teamclaw.controllerSessionKey";
  const CONTROLLER_CONVERSATION_STORAGE_KEY = "teamclaw.controllerConversation";
  let controllerConversation = loadControllerConversation();
  let controllerCommandPending = false;

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  function getSessionStorage() {
    try {
      return window.sessionStorage;
    } catch (_err) {
      return null;
    }
  }

  function loadControllerConversation() {
    const storage = getSessionStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(CONTROLLER_CONVERSATION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  function saveControllerConversation() {
    const storage = getSessionStorage();
    if (!storage) return;
    storage.setItem(CONTROLLER_CONVERSATION_STORAGE_KEY, JSON.stringify(controllerConversation.slice(-50)));
  }

  function getControllerSessionKey() {
    const storage = getSessionStorage();
    const fallback = "default";
    if (!storage) return fallback;
    let sessionKey = storage.getItem(CONTROLLER_SESSION_STORAGE_KEY);
    if (!sessionKey) {
      sessionKey = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : ("web-" + Date.now());
      storage.setItem(CONTROLLER_SESSION_STORAGE_KEY, sessionKey);
    }
    return sessionKey;
  }

  function createControllerConversationEntry(entry) {
    return Object.assign({
      id: "controller-ui-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      createdAt: Date.now(),
    }, entry);
  }

  function appendControllerConversation(entry) {
    controllerConversation = controllerConversation.concat([createControllerConversationEntry(entry)]).slice(-50);
    saveControllerConversation();
    renderMessages(teamState.messages || []);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return h + ":" + m + ":" + s;
  }

  function humanizeStatus(value) {
    return String(value || "").replace(/_/g, " ").replace(/-/g, " ");
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex += 1;
    }
    const digits = size >= 10 || unitIndex === 0 ? 0 : 1;
    return size.toFixed(digits) + " " + units[unitIndex];
  }

  function isWorkspacePreviewAvailable(file) {
    return !!file && (file.previewType === "markdown" || file.previewType === "html");
  }

  function sanitizeUrl(url) {
    const value = String(url || "").trim();
    if (!value) return "#";
    if (/^(https?:|mailto:)/i.test(value)) {
      return value;
    }
    if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || !value.includes(":")) {
      return value;
    }
    return "#";
  }

  function normalizeSkillList(skills) {
    if (!Array.isArray(skills)) {
      return [];
    }
    return skills
      .map(function (skill) { return String(skill || "").trim(); })
      .filter(Boolean);
  }

  function renderSkillPills(skills, className) {
    const items = normalizeSkillList(skills);
    if (items.length === 0) {
      return "";
    }
    return '<div class="' + escapeHtml(className || "skill-pills") + '">' + items.map(function (skill) {
      return '<span class="skill-pill">' + escapeHtml(skill) + "</span>";
    }).join("") + "</div>";
  }

  function renderMarkdownInline(text) {
    const codeTokens = [];
    let safe = escapeHtml(text || "");
    safe = safe.replace(/`([^`]+)`/g, function (_match, code) {
      const token = "@@CODE-TOKEN-" + codeTokens.length + "@@";
      codeTokens.push("<code>" + escapeHtml(code) + "</code>");
      return token;
    });
    safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_match, label, url) {
      return '<a href="' + escapeHtml(sanitizeUrl(url)) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + "</a>";
    });
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    safe = safe.replace(/_([^_]+)_/g, "<em>$1</em>");
    codeTokens.forEach(function (tokenValue, index) {
      safe = safe.replace("@@CODE-TOKEN-" + index + "@@", tokenValue);
    });
    return safe;
  }

  function parseMarkdownTableRow(line) {
    const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map(function (cell) {
      return renderMarkdownInline(cell.trim());
    });
  }

  function renderMarkdown(markdown) {
    const codeBlocks = [];
    const lines = String(markdown || "")
      .replace(/\r\n?/g, "\n")
      .replace(/```([\w-]*)\n([\s\S]*?)```/g, function (_match, language, code) {
        const token = "@@FENCE-BLOCK-" + codeBlocks.length + "@@";
        codeBlocks.push(
          '<pre><code data-language="' + escapeHtml(language || "") + '">' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>"
        );
        return token;
      })
      .split("\n");
    const html = [];
    let index = 0;

    while (index < lines.length) {
      const rawLine = lines[index] || "";
      const line = rawLine.trim();

      if (!line) {
        index += 1;
        continue;
      }

      if (/^@@FENCE-BLOCK-\d+@@$/.test(line)) {
        const blockIndex = Number(line.replace(/\D/g, ""));
        html.push(codeBlocks[blockIndex] || "");
        index += 1;
        continue;
      }

      if (/^#{1,6}\s+/.test(line)) {
        const level = Math.min(6, line.match(/^#+/)[0].length);
        html.push("<h" + level + ">" + renderMarkdownInline(line.slice(level).trim()) + "</h" + level + ">");
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^>\s?/.test((lines[index] || "").trim())) {
          quoteLines.push(renderMarkdownInline((lines[index] || "").trim().replace(/^>\s?/, "")));
          index += 1;
        }
        html.push("<blockquote><p>" + quoteLines.join("<br>") + "</p></blockquote>");
        continue;
      }

      if (/^[-*_]{3,}$/.test(line)) {
        html.push("<hr>");
        index += 1;
        continue;
      }

      if (line.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1] || "")) {
        const headers = parseMarkdownTableRow(line);
        const rows = [];
        index += 2;
        while (index < lines.length && (lines[index] || "").includes("|")) {
          rows.push(parseMarkdownTableRow(lines[index]));
          index += 1;
        }
        html.push(
          "<table><thead><tr>" + headers.map(function (cell) { return "<th>" + cell + "</th>"; }).join("") + "</tr></thead>" +
          "<tbody>" + rows.map(function (row) {
            return "<tr>" + row.map(function (cell) { return "<td>" + cell + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table>"
        );
        continue;
      }

      if (/^([-*+]\s+|\d+\.\s+)/.test(line)) {
        const ordered = /^\d+\.\s+/.test(line);
        const items = [];
        while (index < lines.length) {
          const current = (lines[index] || "").trim();
          const matchesList = ordered ? /^\d+\.\s+/.test(current) : /^[-*+]\s+/.test(current);
          if (!matchesList) {
            break;
          }
          items.push(renderMarkdownInline(current.replace(/^([-*+]\s+|\d+\.\s+)/, "")));
          index += 1;
        }
        html.push((ordered ? "<ol>" : "<ul>") + items.map(function (item) {
          return "<li>" + item + "</li>";
        }).join("") + (ordered ? "</ol>" : "</ul>"));
        continue;
      }

      const paragraphLines = [];
      while (index < lines.length) {
        const currentLine = lines[index] || "";
        const current = currentLine.trim();
        if (!current ||
          /^@@FENCE-BLOCK-\d+@@$/.test(current) ||
          /^#{1,6}\s+/.test(current) ||
          /^>\s?/.test(current) ||
          /^[-*_]{3,}$/.test(current) ||
          /^([-*+]\s+|\d+\.\s+)/.test(current) ||
          (current.includes("|") && index + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1] || ""))) {
          break;
        }
        paragraphLines.push(renderMarkdownInline(current));
        index += 1;
      }
      html.push("<p>" + paragraphLines.join(" ") + "</p>");
    }

    return html.join("");
  }

  function renderMarkdownContent(content) {
    return renderMarkdown(String(content || ""));
  }

  function renderMarkdownCard(content) {
    return '<div class="task-detail-card markdown-body">' + renderMarkdownContent(content) + "</div>";
  }

  function findWorkspaceNodeByPath(nodes, relativePath) {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.path === relativePath) {
        return node;
      }
      if (node.type === "directory" && node.children && node.children.length) {
        const found = findWorkspaceNodeByPath(node.children, relativePath);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  function findDefaultWorkspacePath(nodes) {
    const preferredNames = ["README.md", "SPEC.md", "index.html"];
    const queue = [].concat(nodes || []);
    let firstFile = null;

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;
      if (node.type === "file") {
        if (!firstFile) {
          firstFile = node.path;
        }
        if (preferredNames.indexOf(node.name) !== -1) {
          return node.path;
        }
      }
      if (node.type === "directory" && Array.isArray(node.children)) {
        queue.push.apply(queue, node.children);
      }
    }

    return firstFile;
  }

  function isTaskLive(task) {
    return !!task && ["assigned", "in_progress", "review"].indexOf(task.status) !== -1;
  }

  function getTaskById(taskId) {
    return (teamState.tasks || []).find(function (task) { return task.id === taskId; }) || null;
  }

  function getSelectedTaskExecution() {
    if (!selectedTaskDetail || !selectedTaskDetail.task || !selectedTaskDetail.task.execution) {
      return { events: [] };
    }
    return selectedTaskDetail.task.execution;
  }

  function showError(message) {
    window.alert(message);
  }

  async function apiRequest(path, options) {
    const res = await fetch(API_BASE + path, options);
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }

    if (!res.ok) {
      const message = data && (data.error || data.message)
        ? (data.error || data.message)
        : ("Request failed: " + res.status);
      throw new Error(message);
    }

    return data;
  }

  function apiGet(path) {
    return apiRequest(path);
  }

  function apiPost(path, body) {
    return apiRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function refreshWorkspaceTree(silent) {
    try {
      const data = await apiGet("/workspace/tree");
      workspaceTree = data.entries || [];
      workspaceLoaded = true;
      renderWorkspaceTree(workspaceTree);

      const nextPath = selectedWorkspacePath && findWorkspaceNodeByPath(workspaceTree, selectedWorkspacePath)
        ? selectedWorkspacePath
        : findDefaultWorkspacePath(workspaceTree);

      if (!nextPath) {
        selectedWorkspacePath = null;
        selectedWorkspaceFile = null;
        selectedWorkspaceView = "source";
        renderWorkspaceFile();
        return;
      }

      if (nextPath !== selectedWorkspacePath || !selectedWorkspaceFile) {
        await loadWorkspaceFile(nextPath, { silent: true });
      } else if (activeTab === "workspace") {
        await loadWorkspaceFile(nextPath, { keepView: true, silent: true });
      }
    } catch (err) {
      console.error("Failed to load workspace tree:", err);
      if (!silent) {
        showError(err instanceof Error ? err.message : "Failed to load workspace tree");
      }
    }
  }

  async function loadWorkspaceFile(relativePath, options) {
    const settings = Object.assign({ keepView: false, silent: false }, options || {});
    try {
      const data = await apiGet("/workspace/file?path=" + encodeURIComponent(relativePath));
      selectedWorkspacePath = relativePath;
      selectedWorkspaceFile = data.file || null;
      if (!(settings.keepView && selectedWorkspaceView === "preview" && isWorkspacePreviewAvailable(selectedWorkspaceFile))) {
        selectedWorkspaceView = "source";
      }
      renderWorkspaceTree(workspaceTree);
      renderWorkspaceFile();
    } catch (err) {
      console.error("Failed to load workspace file:", err);
      if (!settings.silent) {
        showError(err instanceof Error ? err.message : "Failed to load workspace file");
      }
    }
  }

  function renderWorkspaceTree(nodes) {
    const container = $("#workspace-tree");
    if (!container) return;

    if (!workspaceLoaded) {
      container.innerHTML = '<div class="empty-state">Workspace tree loading…</div>';
      return;
    }

    if (!nodes || nodes.length === 0) {
      container.innerHTML = '<div class="empty-state">No project files in the workspace yet.</div>';
      return;
    }

    container.innerHTML = renderWorkspaceTreeNodes(nodes);
  }

  function renderWorkspaceTreeNodes(nodes) {
    return '<ul class="workspace-tree-list">' + nodes.map(function (node) {
      if (node.type === "directory") {
        return (
          '<li class="workspace-tree-folder">' +
          '  <details open>' +
          '    <summary class="workspace-tree-summary">' +
          '      <span class="workspace-tree-icon">▾</span>' +
          '      <span class="workspace-tree-label">' + escapeHtml(node.name) + "</span>" +
          "    </summary>" +
          '    <div class="workspace-tree-children">' + renderWorkspaceTreeNodes(node.children || []) + "</div>" +
          "  </details>" +
          "</li>"
        );
      }

      const selectedClass = node.path === selectedWorkspacePath ? " is-selected" : "";
      const previewBadge = node.previewType === "markdown"
        ? "MD"
        : (node.previewType === "html" ? "HTML" : "FILE");

      return (
        '<li>' +
        '  <button type="button" class="workspace-tree-file' + selectedClass + '" data-workspace-path="' + escapeHtml(node.path) + '">' +
        '    <span class="workspace-tree-icon">' + escapeHtml(previewBadge) + "</span>" +
        '    <span class="workspace-tree-label">' + escapeHtml(node.name) + "</span>" +
        "  </button>" +
        "</li>"
      );
    }).join("") + "</ul>";
  }

  function renderWorkspaceFile() {
    const fileName = $("#workspace-file-name");
    const fileMeta = $("#workspace-file-meta");
    const openRaw = $("#workspace-open-raw");

    if (fileName) {
      fileName.textContent = selectedWorkspaceFile ? selectedWorkspaceFile.name : "Select a file";
    }
    if (fileMeta) {
      fileMeta.textContent = selectedWorkspaceFile
        ? [selectedWorkspaceFile.path, formatBytes(selectedWorkspaceFile.size), humanizeStatus(selectedWorkspaceFile.previewType)].join(" • ")
        : "Choose a workspace file to inspect source or preview output.";
    }
    if (openRaw) {
      if (selectedWorkspaceFile && selectedWorkspaceFile.rawUrl) {
        openRaw.href = selectedWorkspaceFile.rawUrl;
        openRaw.classList.remove("hidden");
      } else {
        openRaw.classList.add("hidden");
      }
    }

    const sourceTab = $("#workspace-view-source");
    const previewTab = $("#workspace-view-preview");
    if (sourceTab) {
      sourceTab.classList.toggle("active", selectedWorkspaceView === "source");
    }
    if (previewTab) {
      const previewEnabled = isWorkspacePreviewAvailable(selectedWorkspaceFile);
      previewTab.disabled = !previewEnabled;
      previewTab.classList.toggle("active", selectedWorkspaceView === "preview" && previewEnabled);
    }

    renderWorkspaceSource();
    renderWorkspacePreview();
    syncWorkspaceViewPanels();
  }

  function renderWorkspaceSource() {
    const container = $("#workspace-source-view");
    if (!container) return;

    if (!selectedWorkspaceFile) {
      container.innerHTML = '<div class="workspace-preview-empty">Select a file from the workspace tree to view its source.</div>';
      return;
    }

    if (selectedWorkspaceFile.previewType === "binary") {
      container.innerHTML = '<div class="workspace-preview-empty">This file looks binary. Use <strong>Open Raw</strong> to inspect or download it.</div>';
      return;
    }

    const content = selectedWorkspaceFile.content || "";
    const lines = content.split("\n");
    const warning = selectedWorkspaceFile.truncated
      ? '<div class="workspace-source-warning">Showing the first 256 KB of this file for UI performance.</div>'
      : "";

    container.innerHTML =
      '<div class="workspace-source-shell">' +
      warning +
      '<div class="workspace-source-lines">' +
      lines.map(function (line, index) {
        return (
          '<div class="workspace-source-line">' +
          '  <div class="workspace-source-line-number">' + (index + 1) + "</div>" +
          '  <div class="workspace-source-line-text">' + (line ? escapeHtml(line) : " ") + "</div>" +
          "</div>"
        );
      }).join("") +
      "</div>" +
      "</div>";
    }

  function renderWorkspacePreview() {
    const container = $("#workspace-preview-view");
    if (!container) return;

    if (!selectedWorkspaceFile) {
      container.innerHTML = '<div class="workspace-preview-empty">Select a file from the workspace tree to preview Markdown or HTML output.</div>';
      return;
    }

    if (selectedWorkspaceFile.previewType === "markdown") {
      container.innerHTML = '<div class="workspace-markdown-preview markdown-body">' + renderMarkdownContent(selectedWorkspaceFile.content) + "</div>";
      return;
    }

    if (selectedWorkspaceFile.previewType === "html") {
      container.innerHTML = '<iframe class="workspace-preview-frame" sandbox="allow-scripts allow-forms" src="' + escapeHtml(selectedWorkspaceFile.rawUrl) + '"></iframe>';
      return;
    }

    container.innerHTML = '<div class="workspace-preview-empty">Preview is available for Markdown and HTML files. This file stays in source mode.</div>';
  }

  function syncWorkspaceViewPanels() {
    const sourcePanel = $("#workspace-source-view");
    const previewPanel = $("#workspace-preview-view");
    if (sourcePanel) {
      sourcePanel.classList.toggle("active", selectedWorkspaceView === "source");
    }
    if (previewPanel) {
      previewPanel.classList.toggle("active", selectedWorkspaceView === "preview");
    }
  }

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
      } catch (_err) {
        console.error("Invalid WS message:", event.data);
      }
    };
  }

  function setStatus(status) {
    const dot = $("#connection-status");
    if (dot) {
      dot.className = "status-dot " + status;
    }
  }

  function handleWsEvent(event) {
    const taskId = event && event.data
      ? (event.data.taskId || event.data.id || null)
      : null;

    switch (event.type) {
      case "controller:run":
        handleControllerRunEvent(event.data || {});
        break;
      case "task:execution":
        handleTaskExecutionEvent(event.data || {});
        break;
      case "worker:online":
      case "worker:offline":
      case "task:created":
      case "task:updated":
      case "task:completed":
      case "message:new":
      case "clarification:requested":
      case "clarification:answered":
        refreshAll();
        if (selectedTaskId && taskId && taskId === selectedTaskId) {
          refreshTaskDetail(true);
        }
        break;
    }
  }

  async function refreshAll() {
    try {
      const [statusRes, rolesRes] = await Promise.all([
        apiGet("/team/status"),
        apiGet("/roles"),
      ]);

      teamState = {
        workers: statusRes.workers || [],
        tasks: statusRes.tasks || [],
        controllerRuns: statusRes.controllerRuns || [],
        messages: statusRes.messages || [],
        clarifications: statusRes.clarifications || [],
      };

      renderWorkers(teamState.workers);
      renderTasks(teamState.tasks);
      renderControllerRuns(teamState.controllerRuns);
      renderClarifications(teamState.clarifications);
      renderMessages(teamState.messages);
      renderRoles(rolesRes.roles || []);
      renderClarificationCount(statusRes.pendingClarificationCount || 0);

      const teamName = $("#team-name");
      if (teamName) {
        teamName.textContent = statusRes.teamName || "Team";
      }

      syncSelectedTaskSummary();
      if (activeTab === "workspace") {
        await refreshWorkspaceTree(true);
      }
    } catch (err) {
      console.error("Failed to refresh:", err);
    }
  }

  function renderWorkers(workers) {
    const container = $("#workers-list");
    if (!container) return;

    if (workers.length === 0) {
      container.innerHTML = '<div class="empty-state">No workers connected</div>';
      return;
    }

    container.innerHTML = workers.map(function (worker) {
      return (
        '<div class="worker-card">' +
        '  <span class="worker-icon">' + escapeHtml(worker.label || worker.role).charAt(0) + '</span>' +
        '  <span class="worker-label">' + escapeHtml(worker.label || worker.role) + '</span>' +
        '  <span class="worker-status ' + escapeHtml(worker.status || "offline") + '">' + escapeHtml(worker.status || "offline") + "</span>" +
        "</div>"
      );
    }).join("");
  }

  function renderTasks(tasks) {
    const container = $("#tasks-board");
    if (!container) return;

    const filtered = currentFilter === "all"
      ? tasks
      : tasks.filter(function (task) { return task.status === currentFilter; });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">No tasks' +
        (currentFilter !== "all" ? ' with status "' + escapeHtml(currentFilter) + '"' : "") + "</div>";
      return;
    }

    container.innerHTML = filtered.map(function (task) {
      const priority = task.priority || "medium";
      const status = task.status || "pending";
      const assignee = task.assignedWorkerId
        ? "Assigned to " + task.assignedWorkerId
        : (task.assignedRole ? "Role: " + task.assignedRole : "Unassigned");
      const recommendedSkills = normalizeSkillList(task.recommendedSkills);
      const creatorBadge = task.createdBy
        ? '<span class="task-origin-badge">' + escapeHtml(task.createdBy) + "</span>"
        : "";
      const note = task.progress
        ? '<div class="task-note">' + escapeHtml(task.progress).slice(0, 220) + "</div>"
        : "";
      const clarification = task.clarificationRequestId
        ? '<span>Clarification: ' + escapeHtml(task.clarificationRequestId) + "</span>"
        : "";
      const liveClass = isTaskLive(task) ? " is-live" : "";

      return (
        '<div class="task-card' + liveClass + '" data-task-id="' + escapeHtml(task.id) + '" tabindex="0" role="button" aria-label="Open details for ' + escapeHtml(task.title) + '">' +
        '  <span class="task-priority ' + escapeHtml(priority) + '">' + escapeHtml(priority) + "</span>" +
        '  <div class="task-body">' +
        '    <div class="task-title-row"><div class="task-title">' + escapeHtml(task.title) + "</div>" + creatorBadge + "</div>" +
        (task.description ? '<div class="task-desc">' + escapeHtml(task.description).slice(0, 220) + "</div>" : "") +
        renderSkillPills(recommendedSkills, "skill-pills task-skill-pills") +
        note +
        '    <div class="task-meta">' +
        '      <span class="task-status-badge ' + escapeHtml(status) + '">' + escapeHtml(humanizeStatus(status)) + "</span>" +
        "      <span>" + escapeHtml(assignee) + "</span>" +
        clarification +
        "      <span>" + escapeHtml(formatTime(task.updatedAt)) + "</span>" +
        "    </div>" +
        "  </div>" +
        "</div>"
      );
    }).join("");
  }

  function renderControllerRuns(runs) {
    const container = $("#controller-runs");
    if (!container) return;

    const recentRuns = (runs || [])
      .slice()
      .sort(function (left, right) { return (right.updatedAt || 0) - (left.updatedAt || 0); })
      .slice(0, 12);

    if (recentRuns.length === 0) {
      container.innerHTML = '<div class="empty-state">No controller activity yet</div>';
      return;
    }

    container.innerHTML = recentRuns.map(function (run) {
      const execution = run.execution || {};
      const events = Array.isArray(execution.events) ? execution.events.slice(-5) : [];
      const status = run.status || execution.status || "pending";
      const source = run.source === "task_follow_up"
        ? (run.sourceTaskTitle ? "Follow-up after " + run.sourceTaskTitle : "Workflow follow-up")
        : "Human intake";
      const createdTasks = Array.isArray(run.createdTaskIds) ? run.createdTaskIds : [];
      const createdTaskButtons = createdTasks.length > 0
        ? '<div class="controller-run-created-tasks">' + createdTasks.map(function (taskId) {
          return '<button type="button" class="controller-run-task-link" data-open-task-id="' + escapeHtml(taskId) + '">' + escapeHtml(taskId) + "</button>";
        }).join("") + "</div>"
        : "";
      const replyBlock = run.reply
        ? '<div class="controller-run-section"><div class="controller-run-section-title">Reply</div><div class="markdown-body">' + renderMarkdownContent(run.reply) + "</div></div>"
        : "";
      const errorBlock = run.error
        ? '<div class="controller-run-section"><div class="controller-run-section-title">Error</div><div class="markdown-body">' + renderMarkdownContent(run.error) + "</div></div>"
        : "";
      const eventsBlock = events.length > 0
        ? '<div class="controller-run-events">' + events.map(function (event) {
          const meta = [event.source || "", formatTime(event.createdAt)].filter(Boolean).join(" • ");
          return (
            '<div class="controller-run-event">' +
            '  <div class="controller-run-event-header">' +
            '    <span class="controller-run-event-label">' + escapeHtml(humanizeStatus(event.phase || event.type || "event")) + '</span>' +
            '    <span class="controller-run-event-meta">' + escapeHtml(meta) + "</span>" +
            "  </div>" +
            '  <div class="controller-run-event-body markdown-body">' + renderMarkdownContent(event.message || "") + "</div>" +
            "</div>"
          );
        }).join("") + "</div>"
        : "";

      return (
        '<article class="controller-run-card">' +
        '  <div class="controller-run-header">' +
        '    <div class="controller-run-heading">' +
        '      <div class="controller-run-kicker">' + escapeHtml(source) + "</div>" +
        '      <h3>' + escapeHtml(run.title || "Controller run") + "</h3>" +
        '      <div class="controller-run-meta">Session: ' + escapeHtml(run.sessionKey || "—") + ' • Updated: ' + escapeHtml(formatTime(run.updatedAt) || "—") + "</div>" +
        "    </div>" +
        '    <span class="controller-run-status ' + escapeHtml(status) + '">' + escapeHtml(humanizeStatus(status)) + "</span>" +
        "  </div>" +
        '  <div class="controller-run-section"><div class="controller-run-section-title">Request</div><div class="markdown-body">' + renderMarkdownContent(run.request || "") + "</div></div>" +
        replyBlock +
        errorBlock +
        (createdTaskButtons
          ? '<div class="controller-run-section"><div class="controller-run-section-title">Created Tasks</div>' + createdTaskButtons + "</div>"
          : "") +
        eventsBlock +
        "</article>"
      );
    }).join("");
  }

  function syncSelectedTaskSummary() {
    if (!selectedTaskId || !selectedTaskDetail) {
      return;
    }

    const latestTask = getTaskById(selectedTaskId);
    if (!latestTask) {
      closeTaskDetail();
      return;
    }

    const existingExecution = getSelectedTaskExecution();
    const mergedExecution = Object.assign({}, existingExecution, latestTask.execution || {});
    if (existingExecution.events) {
      mergedExecution.events = existingExecution.events;
    }
    selectedTaskDetail.task = Object.assign({}, selectedTaskDetail.task || {}, latestTask, {
      execution: mergedExecution,
    });
    renderTaskDetail();
  }

  async function openTaskDetail(taskId) {
    selectedTaskId = taskId;
    selectedTaskDetail = {
      task: getTaskById(taskId),
      messages: [],
      clarifications: [],
    };
    const modal = $("#task-detail-modal");
    if (modal) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    }
    renderTaskDetail();
    await refreshTaskDetail(false);
  }

  function closeTaskDetail() {
    selectedTaskId = null;
    selectedTaskDetail = null;
    const modal = $("#task-detail-modal");
    if (modal) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  async function refreshTaskDetail(silent) {
    if (!selectedTaskId) {
      return;
    }

    try {
      const data = await apiGet("/tasks/" + selectedTaskId + "/execution");
      selectedTaskDetail = {
        task: data.task || null,
        messages: data.messages || [],
        clarifications: data.clarifications || [],
      };
      renderTaskDetail();
    } catch (err) {
      console.error("Failed to load task detail:", err);
      if (!silent) {
        showError(err instanceof Error ? err.message : "Failed to load task detail");
      }
    }
  }

  function renderTaskDetail() {
    const task = selectedTaskDetail && selectedTaskDetail.task ? selectedTaskDetail.task : null;
    const title = $("#task-detail-title");
    const subtitle = $("#task-detail-subtitle");
    const liveBadge = $("#task-detail-live-badge");

    if (title) {
      title.textContent = task ? task.title : "Select a task";
    }
    if (subtitle) {
      subtitle.textContent = task
        ? [
            "Task ID: " + task.id,
            task.assignedWorkerId ? "Worker: " + task.assignedWorkerId : null,
            task.assignedRole ? "Role: " + task.assignedRole : null,
          ].filter(Boolean).join(" • ")
        : "";
    }
    if (liveBadge) {
      const live = isTaskLive(task);
      liveBadge.textContent = live ? "Live" : (task ? humanizeStatus(task.status) : "Idle");
      liveBadge.classList.toggle("is-live", live);
    }

    renderTaskDetailOverview(task);
    renderTaskDetailTimeline(task);
    renderTaskDetailOutput(task);
    syncTaskDetailTab();
  }

  function renderTaskDetailOverview(task) {
    const container = $("#task-detail-overview");
    if (!container) return;

    if (!task) {
      container.innerHTML = '<div class="task-detail-empty">Select a task to inspect its execution details.</div>';
      return;
    }

    const execution = task.execution || {};
    const stats = [
      { label: "Status", value: humanizeStatus(task.status) },
      { label: "Priority", value: task.priority || "medium" },
      { label: "Assigned Worker", value: task.assignedWorkerId || "—" },
      { label: "Assigned Role", value: task.assignedRole || "—" },
      { label: "Created", value: formatTime(task.createdAt) || "—" },
      { label: "Updated", value: formatTime(task.updatedAt) || "—" },
      { label: "Started", value: formatTime(task.startedAt || execution.startedAt) || "—" },
      { label: "Completed", value: formatTime(task.completedAt || execution.endedAt) || "—" },
      { label: "Run ID", value: execution.runId || "—" },
      { label: "Execution Status", value: execution.status ? humanizeStatus(execution.status) : "—" },
      { label: "Events", value: String(execution.eventCount || (execution.events ? execution.events.length : 0) || 0) },
      { label: "Created By", value: task.createdBy || "—" },
    ];

    container.innerHTML =
      '<div class="task-detail-grid">' +
      stats.map(function (item) {
        return (
          '<div class="task-detail-stat">' +
          '  <div class="task-detail-stat-label">' + escapeHtml(item.label) + "</div>" +
          '  <div class="task-detail-stat-value">' + escapeHtml(item.value) + "</div>" +
          "</div>"
        );
      }).join("") +
      "</div>" +
      '<div class="task-detail-section">' +
      "  <h3>Description</h3>" +
      renderMarkdownCard(task.description || "No description") +
      "</div>" +
      (normalizeSkillList(task.recommendedSkills).length > 0
        ? '<div class="task-detail-section"><h3>Recommended Skills</h3>' + renderSkillPills(task.recommendedSkills, "skill-pills task-detail-skill-pills") + "</div>"
        : "") +
      (task.progress
        ? '<div class="task-detail-section"><h3>Latest Progress</h3>' + renderMarkdownCard(task.progress) + "</div>"
        : "") +
      (task.result
        ? '<div class="task-detail-section"><h3>Result</h3>' + renderMarkdownCard(task.result) + "</div>"
        : "") +
      (task.error
        ? '<div class="task-detail-section"><h3>Error</h3>' + renderMarkdownCard(task.error) + "</div>"
        : "");
  }

  function buildTimelineEntries(task) {
    if (!task || !selectedTaskDetail) {
      return [];
    }

    const executionEvents = (getSelectedTaskExecution().events || []).map(function (event) {
      return {
        kind: "execution",
        createdAt: event.createdAt || 0,
        label: humanizeStatus(event.phase || event.type),
        meta: [event.source || "execution", event.workerId || event.role || event.stream].filter(Boolean).join(" • "),
        body: event.message || "",
      };
    });

    const messages = (selectedTaskDetail.messages || []).map(function (message) {
      return {
        kind: "message",
        createdAt: message.createdAt || 0,
        label: humanizeStatus(message.type || "message"),
        meta: [message.fromRole || message.from || "unknown", message.toRole ? ("to " + message.toRole) : null].filter(Boolean).join(" • "),
        body: message.content || "",
      };
    });

    return executionEvents.concat(messages).sort(function (left, right) {
      return (left.createdAt || 0) - (right.createdAt || 0);
    });
  }

  function renderTaskDetailTimeline(task) {
    const container = $("#task-detail-timeline");
    if (!container) return;

    if (!task) {
      container.innerHTML = '<div class="task-detail-empty">No task selected.</div>';
      return;
    }

    const entries = buildTimelineEntries(task);
    if (entries.length === 0) {
      container.innerHTML = '<div class="task-detail-empty">No execution history recorded yet.</div>';
      return;
    }

    container.innerHTML = '<div class="task-detail-timeline">' +
      entries.map(function (entry) {
        return (
          '<article class="timeline-entry ' + escapeHtml(entry.kind) + '">' +
          '  <div class="timeline-entry-header">' +
          '    <div class="timeline-entry-label">' + escapeHtml(entry.label) + "</div>" +
          '    <div class="timeline-entry-meta">' + escapeHtml(formatTime(entry.createdAt)) + "</div>" +
          "  </div>" +
          (entry.meta ? '<div class="timeline-entry-meta">' + escapeHtml(entry.meta) + "</div>" : "") +
          '  <div class="timeline-entry-body markdown-body">' + renderMarkdownContent(entry.body) + "</div>" +
          "</article>"
        );
      }).join("") +
      "</div>";

    if (followTaskOutput) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function renderTaskDetailOutput(task) {
    const container = $("#task-detail-output");
    if (!container) return;

    if (!task) {
      container.innerHTML = '<div class="task-detail-empty">No task selected.</div>';
      return;
    }

    const outputEvents = (getSelectedTaskExecution().events || []).filter(function (event) {
      return ["output", "progress", "error"].indexOf(event.type) !== -1;
    });

    if (outputEvents.length === 0) {
      container.innerHTML = '<div class="task-detail-empty">No live output captured yet.</div>';
      return;
    }

    container.innerHTML = '<div class="task-detail-output-stream">' +
      outputEvents.map(function (event) {
        const label = event.stream || humanizeStatus(event.type || "output");
        const meta = [formatTime(event.createdAt), event.source || null, event.workerId || event.role || null]
          .filter(Boolean)
          .join(" • ");
        const stateClass = event.type === "error" ? " is-error" : "";
        return (
          '<article class="task-output-entry' + stateClass + '">' +
          '  <div class="task-output-header">' +
          '    <div class="task-output-label">' + escapeHtml(label) + "</div>" +
          (meta ? '<div class="task-output-meta">' + escapeHtml(meta) + "</div>" : "") +
          "  </div>" +
          '  <div class="task-output-body markdown-body">' + renderMarkdownContent(event.message) + "</div>" +
          "</article>"
        );
      }).join("") +
      "</div>";
    if (followTaskOutput) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function syncTaskDetailTab() {
    $$(".task-detail-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.taskDetailTab === selectedTaskDetailTab);
    });
    ["overview", "timeline", "output"].forEach(function (name) {
      const panel = $("#task-detail-" + name);
      if (panel) {
        panel.classList.toggle("active", name === selectedTaskDetailTab);
      }
    });
  }

  function handleTaskExecutionEvent(payload) {
    if (!payload || !selectedTaskId || payload.taskId !== selectedTaskId) {
      return;
    }

    if (!selectedTaskDetail) {
      selectedTaskDetail = {
        task: getTaskById(selectedTaskId),
        messages: [],
        clarifications: [],
      };
    }

    const task = selectedTaskDetail.task || getTaskById(selectedTaskId) || { id: selectedTaskId };
    const execution = Object.assign({ events: [] }, task.execution || {}, payload.execution || {});
    const events = Array.isArray(execution.events) ? execution.events.slice() : [];
    if (payload.event) {
      events.push(payload.event);
    }
    execution.events = events;
    task.execution = execution;
    selectedTaskDetail.task = Object.assign({}, task);

    renderTaskDetail();
  }

  function handleControllerRunEvent(payload) {
    if (!payload || !payload.id) {
      return;
    }

    const runs = (teamState.controllerRuns || []).slice();
    const index = runs.findIndex(function (run) { return run.id === payload.id; });
    if (index === -1) {
      runs.push(payload);
    } else {
      runs[index] = Object.assign({}, runs[index], payload);
    }
    teamState.controllerRuns = runs;
    renderControllerRuns(teamState.controllerRuns);
  }

  function renderClarifications(clarifications) {
    const container = $("#clarifications-list");
    if (!container) return;

    if (clarifications.length === 0) {
      container.innerHTML = '<div class="empty-state">No clarification requests</div>';
      return;
    }

    container.innerHTML = clarifications.map(function (item) {
      const status = item.status || "pending";
      const context = item.context
        ? '<div class="clarification-context"><strong>Context:</strong> ' + escapeHtml(item.context) + "</div>"
        : "";
      const answerBlock = status === "pending"
        ? (
          '<form class="clarification-answer-form" data-clarification-id="' + escapeHtml(item.id) + '">' +
          '  <label class="clarification-label" for="answer-' + escapeHtml(item.id) + '">Answer as human</label>' +
          '  <textarea id="answer-' + escapeHtml(item.id) + '" name="answer" rows="3" placeholder="Type the exact clarification answer..." required></textarea>' +
          '  <div class="clarification-actions">' +
          '    <button type="submit" class="btn btn-primary">Submit Answer</button>' +
          "  </div>" +
          "</form>"
        )
        : (
          '<div class="clarification-answer">' +
          '  <strong>Answer:</strong> ' + escapeHtml(item.answer || "") +
          (item.answeredBy ? ' <span class="clarification-answer-meta">(by ' + escapeHtml(item.answeredBy) + ')</span>' : "") +
          "</div>"
        );

      return (
        '<div class="clarification-card">' +
        '  <div class="clarification-header">' +
        '    <span class="clarification-status ' + escapeHtml(status) + '">' + escapeHtml(humanizeStatus(status)) + "</span>" +
        '    <span class="clarification-time">' + escapeHtml(formatTime(item.updatedAt || item.createdAt)) + "</span>" +
        "  </div>" +
        '  <div class="clarification-question">' + escapeHtml(item.question) + "</div>" +
        '  <div class="clarification-meta">' +
        '    <span><strong>Task:</strong> ' + escapeHtml(item.taskId) + "</span>" +
        '    <span><strong>Role:</strong> ' + escapeHtml(item.requestedByRole || "unknown") + "</span>" +
        '    <span><strong>Requester:</strong> ' + escapeHtml(item.requestedByWorkerId || item.requestedBy || "unknown") + "</span>" +
        "  </div>" +
        '  <div class="clarification-reason"><strong>Blocked because:</strong> ' + escapeHtml(item.blockingReason) + "</div>" +
        context +
        answerBlock +
        "</div>"
      );
    }).join("");
  }

  function renderClarificationCount(count) {
    const badge = $("#clarifications-tab-count");
    if (!badge) return;

    badge.textContent = String(count);
    badge.classList.toggle("has-items", count > 0);
  }

  function renderMessages(messages) {
    const container = $("#messages-feed");
    if (!container) return;

    const recent = (messages || [])
      .concat(controllerConversation || [])
      .sort(function (left, right) {
        return (right.createdAt || 0) - (left.createdAt || 0);
      })
      .slice(0, 50);
    if (recent.length === 0) {
      container.innerHTML = '<div class="empty-state">No messages yet</div>';
      return;
    }

    container.innerHTML = recent.map(function (message) {
      const from = message.fromRole || message.from || "unknown";
      const type = message.type || "direct";

      return (
        '<div class="message-card">' +
        '  <div class="message-header">' +
        '    <span class="message-from">' + escapeHtml(from) + "</span>" +
        '    <span class="message-type ' + escapeHtml(type) + '">' + escapeHtml(humanizeStatus(type)) + "</span>" +
        "  </div>" +
        '  <div class="message-content markdown-body">' + renderMarkdownContent(message.content) + "</div>" +
        "</div>"
      );
    }).join("");
  }

  function renderRoles(roles) {
    const container = $("#roles-list");
    if (!container) return;

    container.innerHTML = roles.map(function (role) {
      return (
        '<div class="role-chip">' +
        "  <span>" + escapeHtml(role.icon || "") + "</span>" +
        "  <span>" + escapeHtml(role.label) + "</span>" +
        "</div>"
      );
    }).join("");
  }

  $$(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      $$(".tab").forEach(function (item) { item.classList.remove("active"); });
      $$(".tab-panel").forEach(function (panel) { panel.classList.remove("active"); });
      tab.classList.add("active");
      activeTab = tab.dataset.tab || "tasks";
      const panel = $("#tab-" + activeTab);
      if (panel) {
        panel.classList.add("active");
      }
      if (activeTab === "workspace") {
        refreshWorkspaceTree(false);
      }
    });
  });

  $$(".filter-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      $$(".filter-btn").forEach(function (item) { item.classList.remove("active"); });
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderTasks(teamState.tasks || []);
    });
  });

  const workspaceTreeRefresh = $("#workspace-tree-refresh");
  if (workspaceTreeRefresh) {
    workspaceTreeRefresh.addEventListener("click", function () {
      refreshWorkspaceTree(false);
    });
  }

  const workspaceTreeContainer = $("#workspace-tree");
  if (workspaceTreeContainer) {
    workspaceTreeContainer.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target : null;
      const button = target ? target.closest("[data-workspace-path]") : null;
      const relativePath = button && button.dataset ? button.dataset.workspacePath : "";
      if (!relativePath) {
        return;
      }
      loadWorkspaceFile(relativePath, { keepView: true, silent: false });
    });
  }

  $$(".workspace-view-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      const nextView = tab.dataset.workspaceView || "source";
      if (nextView === "preview" && !isWorkspacePreviewAvailable(selectedWorkspaceFile)) {
        return;
      }
      selectedWorkspaceView = nextView;
      renderWorkspaceFile();
    });
  });

  const tasksBoard = $("#tasks-board");
  if (tasksBoard) {
    tasksBoard.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target : null;
      const card = target ? target.closest(".task-card") : null;
      if (card && card.dataset.taskId) {
        openTaskDetail(card.dataset.taskId);
      }
    });

    tasksBoard.addEventListener("keydown", function (event) {
      const target = event.target instanceof Element ? event.target : null;
      const card = target ? target.closest(".task-card") : null;
      if (!card || !card.dataset.taskId) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openTaskDetail(card.dataset.taskId);
      }
    });
  }

  const taskDetailClose = $("#task-detail-close");
  if (taskDetailClose) {
    taskDetailClose.addEventListener("click", closeTaskDetail);
  }
  $$("[data-task-detail-close]").forEach(function (node) {
    node.addEventListener("click", closeTaskDetail);
  });

  const taskDetailRefresh = $("#task-detail-refresh");
  if (taskDetailRefresh) {
    taskDetailRefresh.addEventListener("click", function () {
      refreshTaskDetail(false);
    });
  }

  const followToggle = $("#task-detail-follow-toggle");
  if (followToggle) {
    followToggle.checked = followTaskOutput;
    followToggle.addEventListener("change", function () {
      followTaskOutput = !!followToggle.checked;
      renderTaskDetail();
    });
  }

  $$(".task-detail-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      selectedTaskDetailTab = tab.dataset.taskDetailTab || "overview";
      syncTaskDetailTab();
      renderTaskDetail();
    });
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeTaskDetail();
    }
  });

  const taskForm = $("#create-task-form");
  if (taskForm) {
    taskForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      const title = $("#task-title").value.trim();
      const desc = $("#task-desc").value.trim();
      const recommendedSkills = normalizeSkillList(
        ($("#task-recommended-skills").value || "").split(","),
      );
      const priority = $("#task-priority").value;
      const role = $("#task-role").value;

      if (!title || !desc) return;

      try {
        const body = { title: title, description: desc, priority: priority, createdBy: "boss" };
        if (role) {
          body.assignedRole = role;
        }
        if (recommendedSkills.length > 0) {
          body.recommendedSkills = recommendedSkills;
        }

        await apiPost("/tasks", body);
        taskForm.reset();
        refreshAll();
      } catch (err) {
        console.error("Failed to create task:", err);
        showError(err instanceof Error ? err.message : "Failed to create task");
      }
    });
  }

  document.addEventListener("submit", async function (event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches(".clarification-answer-form")) {
      return;
    }

    event.preventDefault();
    const clarificationId = form.dataset.clarificationId;
    const answerInput = form.querySelector('textarea[name="answer"]');
    const submitButton = form.querySelector('button[type="submit"]');
    const answer = answerInput ? answerInput.value.trim() : "";

    if (!clarificationId || !answer) {
      showError("Please provide an answer before submitting.");
      return;
    }

    if (submitButton) {
      submitButton.disabled = true;
    }

    try {
      await apiPost("/clarifications/" + clarificationId + "/answer", {
        answer: answer,
        answeredBy: "simulated-human",
      });
      refreshAll();
    } catch (err) {
      console.error("Failed to answer clarification:", err);
      showError(err instanceof Error ? err.message : "Failed to answer clarification");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
      }
    }
  });

  const controllerRunsContainer = $("#controller-runs");
  if (controllerRunsContainer) {
    controllerRunsContainer.addEventListener("click", function (event) {
      const target = event.target instanceof Element ? event.target : null;
      const button = target ? target.closest("[data-open-task-id]") : null;
      const taskId = button && button.dataset ? button.dataset.openTaskId : "";
      if (taskId) {
        openTaskDetail(taskId);
      }
    });
  }

  const cmdInput = $("#command-input");
  const cmdSend = $("#command-send");

  function handleCommand() {
    const cmd = (cmdInput && cmdInput.value ? cmdInput.value : "").trim();
    if (!cmd || !cmdInput || controllerCommandPending) return;
    cmdInput.value = "";

    if (cmd === "/status" || cmd === "/s") {
      refreshAll();
      return;
    }

    if (cmd.startsWith("/assign ")) {
      const parts = cmd.split(" ");
      const taskId = parts[1];
      const role = parts[2];
      if (taskId && role) {
        apiPost("/tasks/" + taskId + "/assign", { targetRole: role })
          .then(function () { refreshAll(); })
          .catch(function (err) {
            console.error(err);
            showError(err instanceof Error ? err.message : "Failed to assign task");
          });
      }
      return;
    }

    controllerCommandPending = true;
    if (cmdSend) {
      cmdSend.disabled = true;
    }

    appendControllerConversation({
      from: "human",
      fromRole: "human",
      type: "controller-input",
      content: cmd,
    });

    apiPost("/controller/intake", {
      message: cmd,
      sessionKey: getControllerSessionKey(),
    }).then(function (data) {
      appendControllerConversation({
        from: "controller",
        fromRole: "controller",
        type: "controller-reply",
        content: data && data.reply ? data.reply : "Controller finished without a textual reply.",
      });
      refreshAll();
    }).catch(function (err) {
      console.error(err);
      appendControllerConversation({
        from: "controller",
        fromRole: "controller",
        type: "controller-error",
        content: err instanceof Error ? err.message : "Failed to send message to controller",
      });
      showError(err instanceof Error ? err.message : "Failed to send message to controller");
    }).finally(function () {
      controllerCommandPending = false;
      if (cmdSend) {
        cmdSend.disabled = false;
      }
    });
  }

  if (cmdSend) {
    cmdSend.addEventListener("click", handleCommand);
  }

  if (cmdInput) {
    cmdInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        handleCommand();
      }
    });
  }

  renderWorkspaceTree(workspaceTree);
  renderWorkspaceFile();
  refreshAll();
  connectWebSocket();
})();
