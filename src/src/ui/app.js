// TeamClaw Web UI
(function () {
  "use strict";

  const API_BASE = "/api/v1";
  let ws = null;
  let currentFilter = "all";
  let taskKeywordFilter = "";
  let terminalTasksVisible = 20;
  let activeTab = "tasks";
  let teamState = { workers: [], tasks: [], controllerRuns: [], messages: [], clarifications: [], modelReadiness: null, externalWorkerInstall: null };
  let selectedExternalWorkerRole = "developer";
  let selectedExternalWorkerDiscoveryMode = "mdns";
  let externalWorkerInstallVisible = false;
  let selectedTaskId = null;
  let selectedTaskDetail = null;
  let selectedTaskDetailTab = "details";
  let taskTimelineAutoFollow = true;
  let workspaceTree = [];
  let selectedWorkspacePath = null;
  let selectedWorkspaceFile = null;
  let selectedWorkspaceView = "source";
  let workspaceLoaded = false;
  let clarificationPromptOpen = false;
  let activeClarificationId = null;
  let dismissedClarificationIds = [];
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let isConnecting = false;
  const CONTROLLER_SESSION_STORAGE_KEY = "teamclaw.controllerSessionKey";
  const CONTROLLER_CONVERSATION_STORAGE_KEY = "teamclaw.controllerConversation";
  const LANGUAGE_STORAGE_KEY = "teamclaw.ui.language";
  let controllerConversation = loadControllerConversation();
  let controllerCommandPending = false;
  const initialUiState = parseInitialUiState();
  let initialUiStateApplied = false;
  let currentLanguage = loadLanguage();

  const TRANSLATIONS = {
    en: {
      "action.refresh": "Refresh",
      "action.close": "Close",
      "action.dismiss": "Dismiss",
      "action.copyCommand": "Copy command",
      "action.copied": "Copied",
      "sidebar.workers": "Workers",
      "sidebar.roles": "Roles",
      "tab.planning": "Planning",
      "tab.tasks": "Tasks",
      "tab.workspace": "Workspace",
      "tab.teamauto": "TeamAuto",
      "tab.clarifications": "Clarifications",
      "tab.messages": "Messages",
      "tab.manualTask": "Manual Task",
      "planning.title": "Team Planning",
      "planning.description": "Submit a requirement via the command bar below. Complex projects (3+ roles) will trigger a team kickoff meeting where each role assesses the requirement collaboratively.",
      "planning.sessions": "Sessions",
      "planning.requirement": "Requirement",
      "planning.kickoff": "Team Kickoff Meeting",
      "planning.controllerOutput": "Controller Output",
      "planning.originalRequest": "Original Request",
      "planning.requiredRoles": "Required Roles",
      "planning.plannedTasks": "Planned Tasks",
      "planning.deferredTasks": "Deferred Tasks",
      "planning.clarificationsNeeded": "Clarifications Needed",
      "planning.notes": "Notes",
      "planning.noControllerOutput": "No controller output yet.",
      "workspace.preview": "Preview",
      "workspace.selectFile": "Select a file",
      "workspace.openRaw": "Open Raw",
      "workspace.source": "Source",
      "workspace.files": "Files",
      "messages.panelNote": "Controller activity is persisted here so you can follow requirement intake, orchestration, and follow-up runs from the web UI.",
      "manualTask.note": "Raw human requirements should go to the controller conversation first. Use this form only for explicit manual task injection or testing.",
      "manualTask.title": "Title",
      "manualTask.description": "Description",
      "manualTask.skills": "Recommended Skills",
      "manualTask.priority": "Priority",
      "manualTask.assignedRole": "Assigned Role",
      "manualTask.autoAssign": "Auto-assign",
      "manualTask.create": "Create Manual Task",
      "manualTask.titlePlaceholder": "Task title...",
      "manualTask.descriptionPlaceholder": "Execution-ready task description...",
      "manualTask.skillsPlaceholder": "Comma-separated skill slugs, e.g. find-skills, ui-ux-pro-max",
      "empty.noWorkers": "No workers connected",
      "empty.noTasks": "No tasks yet",
      "empty.noTasksWithStatus": "No tasks with status \"{status}\"",
      "empty.noClarifications": "No clarification requests",
      "empty.noControllerActivity": "No controller activity yet",
      "empty.noMessages": "No messages yet",
      "empty.noPlanningSessions": "No planning sessions yet",
      "empty.noKickoffData": "No kickoff data",
      "empty.workspaceLoading": "Workspace tree loading…",
      "empty.noWorkspaceFiles": "No project files in the workspace yet.",
      "empty.selectFileSource": "Select a file from the workspace tree to view its source.",
      "empty.selectFilePreview": "Select a file from the workspace tree to preview Markdown or HTML output.",
      "empty.selectTask": "Select a task",
      "empty.taskDetail": "Select a task to inspect its execution details.",
      "empty.taskMessages": "No messages on this task yet.",
      "empty.taskHistory": "No execution history recorded yet.",
      "empty.copiedControllerReply": "Controller finished without a textual reply.",
      "runtime.title": "TeamClaw is installed but cannot work yet.",
      "runtime.noModel": "No TeamClaw model is configured for this instance.",
      "runtime.noAuth": "No usable OpenClaw auth profile was found for TeamClaw.",
      "gh.login": "Sign in with GitHub",
      "teamauto.refreshRepos": "Refresh repos",
      "teamauto.bind": "Bind",
      "teamauto.bindStageVerify": "Verifying access",
      "teamauto.bindStageClone": "Cloning repository",
      "teamauto.bindStageNorms": "Learning repo conventions",
      "teamauto.bindReady": "Repository ready",
      "teamauto.bindFailed": "Binding failed",
      "teamauto.close": "Close",
      "teamauto.provisioning": "preparing",
      "teamauto.provisionFailed": "setup failed",
      "teamauto.hint": "Pick one of your GitHub repositories. TeamClaw sweeps it on its own schedule, reviews issues/PRs, takes ownership of unassigned issues, and posts results with teamclaw markers.",
      "teamauto.loginFirst": "Sign in to GitHub first (top-right Login).",
      "teamauto.loadingRepos": "Loading your repos...",
      "teamauto.noCandidates": "No selectable repos (check GitHub login). You can type owner/repo manually:",
      "teamauto.needRepo": "Select a repository first",
      "teamauto.active": "active",
      "teamauto.disabled": "disabled",
      "teamauto.paused": "paused",
      "teamauto.sweep": "Sweep now",
      "teamauto.disable": "Disable",
      "teamauto.enable": "Enable",
      "teamauto.unbind": "Unbind",
      "teamauto.save": "Save config",
      "teamauto.saved": "Saved",
      "teamauto.schedule": "Schedule",
      "teamauto.maxPerSweep": "Max/sweep",
      "teamauto.fullReview": "Full review",
      "teamauto.takeOwnership": "Take ownership",
      "teamauto.lastSweep": "Last sweep",
      "teamauto.norms": "Norms",
      "teamauto.confirmUnbind": "Unbind this repo?",
      "teamauto.empty": "No repos bound yet. Pick one above and click Bind.",
      "teamauto.activity": "Activity",
      "teamauto.activityEmpty": "No TeamAuto activity yet - sweeps and write-backs will appear here.",
      "worker.add": "Add worker",
      "worker.hide": "Hide worker command",
      "worker.cardTitle": "Register a new external worker",
      "worker.cardSubtitle": "Choose a role and discovery mode, then copy a one-line installer command for the target machine.",
      "worker.role": "Role",
      "worker.discovery": "Controller discovery",
      "worker.discoveryMdns": "LAN auto-discovery (mDNS)",
      "worker.discoveryManual": "Manual controller URL (LAN IP)",
      "worker.recommendedUrl": "Recommended controller URL: ",
      "filter.all": "All",
      "filter.pending": "Pending",
      "filter.assigned": "Assigned",
      "filter.in_progress": "In Progress",
      "filter.blocked": "Blocked",
      "filter.completed": "Completed",
      "filter.failed": "Failed",
      "tasks.searchPlaceholder": "Filter by keyword...",
      "tasks.showMore": "Show {n} more completed",
      "tasks.noMatch": "No tasks match the keyword",
      "priority.low": "Low",
      "priority.medium": "Medium",
      "priority.high": "High",
      "priority.critical": "Critical",
      "detail.kicker": "Task Details",
      "live.idle": "Idle",
      "clarification.kicker": "Clarification needed",
      "clarification.title": "Human input required"
    },
    zh: {
      "action.refresh": "刷新",
      "action.close": "关闭",
      "action.dismiss": "稍后处理",
      "action.copyCommand": "复制命令",
      "action.copied": "已复制",
      "sidebar.workers": "成员",
      "sidebar.roles": "角色",
      "tab.planning": "规划",
      "tab.tasks": "任务",
      "tab.workspace": "工作区",
      "tab.teamauto": "TeamAuto",
      "tab.clarifications": "澄清",
      "tab.messages": "消息",
      "tab.manualTask": "手动任务",
      "planning.title": "团队规划",
      "planning.description": "通过下方命令栏提交需求。复杂项目（3 个及以上角色）会触发团队 kickoff 会议，由各角色协作评估需求。",
      "planning.sessions": "会话",
      "planning.requirement": "需求",
      "planning.kickoff": "团队 Kickoff 会议",
      "planning.controllerOutput": "Controller 输出",
      "planning.originalRequest": "原始请求",
      "planning.requiredRoles": "所需角色",
      "planning.plannedTasks": "计划任务",
      "planning.deferredTasks": "延后任务",
      "planning.clarificationsNeeded": "待澄清问题",
      "planning.notes": "备注",
      "planning.noControllerOutput": "暂无 controller 输出。",
      "workspace.preview": "预览",
      "workspace.selectFile": "选择文件",
      "workspace.openRaw": "打开原始文件",
      "workspace.source": "源码",
      "workspace.files": "文件",
      "messages.panelNote": "这里会保留 controller 活动，方便你在 Web UI 中跟踪需求 intake、编排过程和后续跟进。",
      "manualTask.note": "原始人工需求应先发送到 controller 对话。这个表单仅用于明确的手动任务注入或测试。",
      "manualTask.title": "标题",
      "manualTask.description": "描述",
      "manualTask.skills": "推荐技能",
      "manualTask.priority": "优先级",
      "manualTask.assignedRole": "指定角色",
      "manualTask.autoAssign": "自动分配",
      "manualTask.create": "创建手动任务",
      "manualTask.titlePlaceholder": "任务标题...",
      "manualTask.descriptionPlaceholder": "可直接执行的任务描述...",
      "manualTask.skillsPlaceholder": "逗号分隔的 skill slug，例如 find-skills, ui-ux-pro-max",
      "empty.noWorkers": "暂无已连接成员",
      "empty.noTasks": "暂无任务",
      "empty.noTasksWithStatus": "没有状态为“{status}”的任务",
      "empty.noClarifications": "暂无澄清请求",
      "empty.noControllerActivity": "暂无 controller 活动",
      "empty.noMessages": "暂无消息",
      "empty.noPlanningSessions": "暂无规划会话",
      "empty.noKickoffData": "暂无 kickoff 数据",
      "empty.workspaceLoading": "工作区树加载中…",
      "empty.noWorkspaceFiles": "工作区中还没有项目文件。",
      "empty.selectFileSource": "从工作区文件树选择文件以查看源码。",
      "empty.selectFilePreview": "从工作区文件树选择文件以预览 Markdown 或 HTML 输出。",
      "empty.selectTask": "选择一个任务",
      "empty.taskDetail": "选择一个任务以查看执行细节。",
      "empty.taskMessages": "该任务暂无消息。",
      "empty.taskHistory": "暂无执行历史。",
      "empty.copiedControllerReply": "Controller 已完成，但没有文本回复。",
      "runtime.title": "TeamClaw 已安装，但当前还无法工作。",
      "runtime.noModel": "当前实例还没有为 TeamClaw 配置模型。",
      "runtime.noAuth": "未找到 TeamClaw 可用的 OpenClaw 认证配置。",
      "gh.login": "使用 GitHub 登录",
      "teamauto.refreshRepos": "刷新仓库",
      "teamauto.bind": "绑定",
      "teamauto.bindStageVerify": "验证访问权限",
      "teamauto.bindStageClone": "克隆仓库中",
      "teamauto.bindStageNorms": "学习仓库规范",
      "teamauto.bindReady": "仓库就绪",
      "teamauto.bindFailed": "绑定失败",
      "teamauto.close": "关闭",
      "teamauto.provisioning": "准备中",
      "teamauto.provisionFailed": "准备失败",
      "teamauto.hint": "选择你的 GitHub 仓库。TeamClaw 按各自节奏定时扫描，自主 review issue/PR、认领未分配 issue，并以 teamclaw 标识写回结果。",
      "teamauto.loginFirst": "请先登录 GitHub（右上角 Login）。",
      "teamauto.loadingRepos": "正在加载你的仓库...",
      "teamauto.noCandidates": "无可选仓库（请检查 GitHub 登录），可手动输入 owner/repo：",
      "teamauto.needRepo": "请先选择一个仓库",
      "teamauto.active": "运行中",
      "teamauto.disabled": "已停用",
      "teamauto.paused": "已暂停",
      "teamauto.sweep": "立即扫描",
      "teamauto.disable": "停用",
      "teamauto.enable": "启用",
      "teamauto.unbind": "解绑",
      "teamauto.save": "保存配置",
      "teamauto.saved": "已保存",
      "teamauto.schedule": "节奏",
      "teamauto.maxPerSweep": "每轮上限",
      "teamauto.fullReview": "全量 review",
      "teamauto.takeOwnership": "认领 issue",
      "teamauto.lastSweep": "上次扫描",
      "teamauto.norms": "协作规范",
      "teamauto.confirmUnbind": "确定解绑该仓库？",
      "teamauto.empty": "尚未绑定仓库。在上方选择后点击绑定。",
      "teamauto.activity": "动态",
      "teamauto.activityEmpty": "暂无 TeamAuto 动态-扫描与写回会出现在这里。",
      "worker.add": "添加 worker",
      "worker.hide": "隐藏 worker 命令",
      "worker.cardTitle": "注册新的外部 worker",
      "worker.cardSubtitle": "选择角色和发现方式，然后复制目标机器可直接执行的一行安装命令。",
      "worker.role": "角色",
      "worker.discovery": "Controller 发现方式",
      "worker.discoveryMdns": "局域网自动发现（mDNS）",
      "worker.discoveryManual": "手动填写 controller 地址（局域网 IP）",
      "worker.recommendedUrl": "推荐的 controller 地址：",
      "filter.all": "全部",
      "filter.pending": "待处理",
      "filter.assigned": "已分配",
      "filter.in_progress": "进行中",
      "filter.blocked": "阻塞",
      "filter.completed": "已完成",
      "filter.failed": "失败",
      "tasks.searchPlaceholder": "关键字过滤...",
      "tasks.showMore": "再显示 {n} 条已结束",
      "tasks.noMatch": "没有匹配关键字的任务",
      "priority.low": "低",
      "priority.medium": "中",
      "priority.high": "高",
      "priority.critical": "紧急",
      "detail.kicker": "任务详情",
      "live.idle": "空闲",
      "clarification.kicker": "需要澄清",
      "clarification.title": "需要人工输入"
    }
  };

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  function loadLanguage() {
    try {
      var stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      return stored === "zh" ? "zh" : "en";
    } catch (_err) {
      return "en";
    }
  }

  function t(key, params) {
    var template = (TRANSLATIONS[currentLanguage] && TRANSLATIONS[currentLanguage][key]) || TRANSLATIONS.en[key] || key;
    return template.replace(/\{(\w+)\}/g, function (_match, name) {
      return params && params[name] != null ? String(params[name]) : "";
    });
  }

  function setLanguage(language) {
    currentLanguage = language === "zh" ? "zh" : "en";
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguage);
    } catch (_err) {}
    document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
    applyStaticTranslations();
    refreshAll();
  }

  function applyStaticTranslations() {
    $$("[data-i18n]").forEach(function (element) {
      var key = element.getAttribute("data-i18n");
      if (key) {
        element.textContent = t(key);
      }
    });
    $$("[data-i18n-placeholder]").forEach(function (element) {
      var key = element.getAttribute("data-i18n-placeholder");
      if (key) {
        element.setAttribute("placeholder", t(key));
      }
    });
    var languageToggle = $("#language-toggle");
    if (languageToggle) {
      languageToggle.textContent = currentLanguage === "zh" ? "English" : "中文";
    }
    var filters = {
      all: "filter.all",
      pending: "filter.pending",
      assigned: "filter.assigned",
      in_progress: "filter.in_progress",
      blocked: "filter.blocked",
      completed: "filter.completed",
      failed: "filter.failed"
    };
    $$("[data-filter]").forEach(function (button) {
      var key = filters[button.getAttribute("data-filter") || "all"];
      if (key) button.textContent = t(key);
    });
    ["low", "medium", "high", "critical"].forEach(function (priority) {
      var option = $('#task-priority option[value="' + priority + '"]');
      if (option) option.textContent = t("priority." + priority);
    });
    var planningHeader = $(".planning-sessions-header");
    if (planningHeader) planningHeader.textContent = t("planning.sessions");
    var workspaceKicker = $(".workspace-sidebar-panel .workspace-panel-kicker");
    if (workspaceKicker) workspaceKicker.textContent = t("tab.workspace");
    var workspaceTitle = $(".workspace-sidebar-panel h3");
    if (workspaceTitle) workspaceTitle.textContent = t("workspace.files");
    var planningPaneTitles = $$(".planning-pane-title");
    if (planningPaneTitles[0]) planningPaneTitles[0].textContent = t("planning.requirement");
    if (planningPaneTitles[1]) planningPaneTitles[1].textContent = t("planning.kickoff");
    var promptKicker = $(".clarification-prompt-kicker");
    if (promptKicker) promptKicker.textContent = t("clarification.kicker");
    var promptTitle = $("#clarification-prompt-title");
    if (promptTitle) promptTitle.textContent = t("clarification.title");
    var promptClose = $("#clarification-prompt-close");
    if (promptClose) promptClose.textContent = t("action.dismiss");
    var detailKicker = $(".task-detail-kicker");
    if (detailKicker) detailKicker.textContent = t("detail.kicker");
    var detailClose = $("#task-detail-close");
    if (detailClose) detailClose.textContent = t("action.close");
    var detailRefresh = $("#task-detail-refresh");
    if (detailRefresh) detailRefresh.textContent = t("action.refresh");
    var liveBadge = $("#task-detail-live-badge");
    if (liveBadge && liveBadge.textContent === "Idle") liveBadge.textContent = t("live.idle");
  }

  function parseInitialUiState() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      // Hash routing (#/tab/<name>) wins over legacy query params and survives
      // refresh; query params are kept for old bookmarks/links.
      const hashMatch = /^#\/tab\/([a-z][a-z0-9-]*)$/i.exec(window.location.hash || "");
      return {
        tab: hashMatch ? hashMatch[1] : (params.get("tab") || ""),
        taskId: params.get("taskId") || "",
        planningRun: params.get("planningRun") || "",
      };
    } catch (_err) {
      return { tab: "", taskId: "", planningRun: "" };
    }
  }

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

  async function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return;
    }
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
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

  function normalizeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function sortClarifications(items) {
    return normalizeArray(items).slice().sort(function (left, right) {
      return (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0);
    });
  }

  function pendingClarifications() {
    return sortClarifications(teamState.clarifications).filter(function (item) {
      return !item.answer && (item.status || "pending") === "pending";
    });
  }

  function isTerminalPlanningStatus(status) {
    return ["completed", "failed", "cancelled"].indexOf(String(status || "").toLowerCase()) !== -1;
  }

  function activePlanningRunCount() {
    return normalizeArray(teamState.controllerRuns).filter(function (run) {
      return run.manifest && run.manifest.kickoffPlan && !isTerminalPlanningStatus(run.status);
    }).length;
  }

  function activeTaskCount() {
    return normalizeArray(teamState.tasks).filter(function (task) {
      return ["assigned", "in_progress", "review"].indexOf(task.status) !== -1;
    }).length;
  }

  function blockedTaskCount() {
    return normalizeArray(teamState.tasks).filter(function (task) {
      return task.status === "blocked";
    }).length;
  }

  function isNearBottom(element) {
    if (!element) return true;
    return (element.scrollHeight - element.scrollTop - element.clientHeight) < 48;
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

  function normalizeTextValue(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function renderContractChips(items, className) {
    const normalized = Array.isArray(items)
      ? items.map(function (item) { return normalizeTextValue(item); }).filter(Boolean)
      : [];
    if (normalized.length === 0) {
      return "";
    }
    return '<div class="' + escapeHtml(className || "contract-chip-row") + '">' + normalized.map(function (item) {
      return '<span class="contract-chip">' + escapeHtml(item) + "</span>";
    }).join("") + "</div>";
  }

  function renderContractList(items, formatter, className) {
    const values = Array.isArray(items) ? items.filter(Boolean) : [];
    if (values.length === 0) {
      return "";
    }
    return '<ul class="' + escapeHtml(className || "contract-list") + '">' + values.map(function (item) {
      return "<li>" + formatter(item) + "</li>";
    }).join("") + "</ul>";
  }

  function renderContractMetaRows(rows) {
    const items = (rows || []).filter(function (row) {
      return row && normalizeTextValue(row.label) && normalizeTextValue(row.value);
    });
    if (items.length === 0) {
      return "";
    }
    return '<div class="contract-meta-grid">' + items.map(function (row) {
      return (
        '<div class="contract-meta-item">' +
        '  <div class="contract-meta-label">' + escapeHtml(row.label) + "</div>" +
        '  <div class="contract-meta-value">' + escapeHtml(row.value) + "</div>" +
        "</div>"
      );
    }).join("") + "</div>";
  }

  function renderContractSection(title, bodyHtml) {
    if (!normalizeTextValue(bodyHtml)) {
      return "";
    }
    return (
      '<div class="contract-section">' +
      '  <div class="contract-section-title">' + escapeHtml(title) + "</div>" +
      bodyHtml +
      "</div>"
    );
  }

  function renderContractMarkdownBody(content) {
    if (!normalizeTextValue(content)) {
      return "";
    }
    return '<div class="contract-markdown markdown-body">' + renderMarkdownContent(content) + "</div>";
  }

  function renderContractCard(options) {
    const tone = options && options.tone ? " contract-card-" + options.tone : "";
    const kicker = options && options.kicker ? '<div class="contract-card-kicker">' + escapeHtml(options.kicker) + "</div>" : "";
    const title = options && options.title ? '<h4 class="contract-card-title">' + escapeHtml(options.title) + "</h4>" : "";
    const meta = options && options.metaHtml ? options.metaHtml : "";
    const sections = Array.isArray(options && options.sections)
      ? options.sections.filter(function (section) { return normalizeTextValue(section); }).join("")
      : "";
    const footer = options && options.footerHtml ? options.footerHtml : "";

    if (!kicker && !title && !meta && !sections && !footer) {
      return "";
    }

    return (
      '<div class="contract-card' + tone + '">' +
      '  <div class="contract-card-header">' +
      kicker +
      title +
      meta +
      "  </div>" +
      sections +
      footer +
      "</div>"
    );
  }

  function renderResultContractCard(contract) {
    if (!contract || !normalizeTextValue(contract.summary)) {
      return "";
    }
    const deliverables = Array.isArray(contract.deliverables) ? contract.deliverables : [];
    const followUps = Array.isArray(contract.followUps) ? contract.followUps : [];
    return renderContractCard({
      tone: contract.outcome || "completed",
      kicker: "Structured Result Contract",
      title: contract.summary,
      metaHtml: renderContractMetaRows([
        { label: "Outcome", value: humanizeStatus(contract.outcome || "completed") },
        { label: "Deliverables", value: String(deliverables.length) },
        { label: "Follow-ups", value: String(followUps.length) },
      ]),
      sections: [
        renderContractSection("Deliverables", renderContractList(deliverables, function (item) {
          const prefix = escapeHtml(item.kind || "artifact") + ": " + escapeHtml(item.value || "");
          var liveLink = "";
          if (item.artifactType === "web-app" && item.liveUrl) {
            liveLink = ' <a class="deliverable-live-link" href="' + escapeHtml(item.liveUrl) + '" target="_blank" rel="noopener">Live Preview</a>';
          }
          return prefix + (item.summary ? ' <span class="contract-inline-note">— ' + escapeHtml(item.summary) + "</span>" : "") + liveLink;
        })),
        renderContractSection("Key Points", renderContractList(contract.keyPoints, function (item) {
          return renderMarkdownInline(item);
        })),
        renderContractSection("Blockers", renderContractList(contract.blockers, function (item) {
          return renderMarkdownInline(item);
        })),
        renderContractSection("Follow-ups", renderContractList(followUps, function (item) {
          const prefix = escapeHtml(item.type || "follow-up") + (item.targetRole ? " (" + escapeHtml(item.targetRole) + ")" : "");
          return prefix + ": " + renderMarkdownInline(item.reason || "");
        })),
        renderContractSection("Open Questions", renderContractList(contract.questions, function (item) {
          return renderMarkdownInline(item);
        })),
        renderContractSection("Notes", renderContractMarkdownBody(contract.notes)),
      ],
    });
  }

  function renderProgressContractCard(contract) {
    if (!contract || !normalizeTextValue(contract.summary)) {
      return "";
    }
    return renderContractCard({
      tone: contract.status || "in_progress",
      kicker: "Structured Progress Contract",
      title: contract.summary,
      metaHtml: renderContractMetaRows([
        { label: "Status", value: humanizeStatus(contract.status || "in_progress") },
        { label: "Blockers", value: String((contract.blockers || []).length) },
      ]),
      sections: [
        renderContractSection("Current Step", renderContractMarkdownBody(contract.currentStep)),
        renderContractSection("Next Step", renderContractMarkdownBody(contract.nextStep)),
        renderContractSection("Blockers", renderContractList(contract.blockers, function (item) {
          return renderMarkdownInline(item);
        })),
      ],
    });
  }

  function renderHandoffContractCard(contract) {
    if (!contract || !normalizeTextValue(contract.summary)) {
      return "";
    }
    return renderContractCard({
      tone: "handoff",
      kicker: "Structured Handoff Contract",
      title: contract.summary,
      metaHtml: renderContractMetaRows([
        { label: "Target Role", value: contract.targetRole || "—" },
        { label: "Artifacts", value: String((contract.artifacts || []).length) },
      ]),
      sections: [
        renderContractSection("Reason", renderContractMarkdownBody(contract.reason)),
        renderContractSection("Expected Next Step", renderContractMarkdownBody(contract.expectedNextStep)),
      ],
      footerHtml: renderContractChips(contract.artifacts, "contract-chip-row contract-reference-row"),
    });
  }

  function renderTeamMessageContractCard(contract) {
    if (!contract || !normalizeTextValue(contract.summary)) {
      return "";
    }
    return renderContractCard({
      tone: contract.intent || "update",
      kicker: "Structured Message Contract",
      title: contract.summary,
      metaHtml: renderContractMetaRows([
        { label: "Intent", value: humanizeStatus(contract.intent || "update") },
        { label: "Needs Response", value: contract.needsResponse ? "Yes" : "No" },
        { label: "Requested Role", value: contract.requestedRole || "—" },
      ]),
      sections: [
        renderContractSection("Details", renderContractMarkdownBody(contract.details)),
        renderContractSection("Requested Action", renderContractMarkdownBody(contract.requestedAction)),
      ],
      footerHtml: renderContractChips(contract.references, "contract-chip-row contract-reference-row"),
    });
  }

  function renderControllerManifestCard(manifest) {
    if (!manifest || !normalizeTextValue(manifest.requirementSummary)) {
      return "";
    }
    const createdTasks = Array.isArray(manifest.createdTasks) ? manifest.createdTasks : [];
    const deferredTasks = Array.isArray(manifest.deferredTasks) ? manifest.deferredTasks : [];
    return renderContractCard({
      tone: "manifest",
      kicker: "Structured Manifest",
      title: manifest.requirementSummary,
      metaHtml: renderContractMetaRows([
        { label: "Required Roles", value: String((manifest.requiredRoles || []).length) },
        { label: "Created Tasks", value: String(createdTasks.length) },
        { label: "Deferred Tasks", value: String(deferredTasks.length) },
      ]),
      sections: [
        renderContractSection("Required Roles", renderContractChips(manifest.requiredRoles, "contract-chip-row contract-role-row")),
        renderContractSection("Created Tasks", renderContractList(createdTasks, function (item) {
          const roleLabel = item.assignedRole ? " (" + escapeHtml(item.assignedRole) + ")" : "";
          return '<strong>' + escapeHtml(item.title || "Task") + roleLabel + "</strong>: " + renderMarkdownInline(item.expectedOutcome || "");
        })),
        renderContractSection("Deferred Tasks", renderContractList(deferredTasks, function (item) {
          const roleLabel = item.assignedRole ? " (" + escapeHtml(item.assignedRole) + ")" : "";
          return '<strong>' + escapeHtml(item.title || "Task") + roleLabel + "</strong>: " + renderMarkdownInline(item.blockedBy || "") + " — create when " + renderMarkdownInline(item.whenReady || "");
        })),
        renderContractSection("Clarifications", renderContractList(manifest.clarificationQuestions, function (item) {
          return renderMarkdownInline(item);
        })),
        renderContractSection("Handoff Plan", renderContractMarkdownBody(manifest.handoffPlan)),
        renderContractSection("Notes", renderContractMarkdownBody(manifest.notes)),
      ],
    });
  }

  var ROLE_ICONS = {
    architect: "🏗️",
    developer: "💻",
    designer: "🎨",
    "security-engineer": "🔒",
    qa: "🧪",
    devops: "⚙️",
    "tech-lead": "👨‍💻",
    "data-engineer": "📊",
    "ml-engineer": "🤖",
    "infra-engineer": "🖧",
    "dba": "🗄️",
  };

  function renderKickoffMeetingPanel(kickoffPlan) {
    if (!kickoffPlan || !Array.isArray(kickoffPlan.assessments) || kickoffPlan.assessments.length === 0) {
      return "";
    }
    var assessments = kickoffPlan.assessments;
    var needed = assessments.filter(function (a) { return a.needed; }).length;
    var notNeeded = assessments.length - needed;

    var header =
      '<div class="kickoff-panel-header">' +
      '  <div class="kickoff-panel-icon">🤝</div>' +
      '  <div class="kickoff-panel-heading">' +
      '    <h4>Team Kickoff Meeting</h4>' +
      '    <div class="kickoff-panel-meta">' +
           assessments.length + " roles assessed · " +
           needed + " confirmed" +
           (notNeeded > 0 ? " · " + notNeeded + " dismissed" : "") +
      "    </div>" +
      "  </div>" +
      "</div>";

    var roleCards = assessments.map(function (a) {
      var icon = ROLE_ICONS[a.role] || "👤";
      var statusCls = a.needed ? "kickoff-role-needed" : "kickoff-role-dismissed";
      var statusLabel = a.needed ? "Confirmed" : "Not Needed";

      var scopeHtml = a.scope
        ? '<div class="kickoff-role-scope">' + renderMarkdownContent(a.scope) + "</div>"
        : "";

      var tasksHtml = "";
      if (Array.isArray(a.suggestedTasks) && a.suggestedTasks.length > 0) {
        tasksHtml =
          '<div class="kickoff-role-detail">' +
          '  <div class="kickoff-detail-label">📋 Suggested Tasks</div>' +
          '  <ul class="kickoff-detail-list">' +
             a.suggestedTasks.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("") +
          "  </ul>" +
          "</div>";
      }

      var risksHtml = "";
      if (Array.isArray(a.risks) && a.risks.length > 0) {
        risksHtml =
          '<div class="kickoff-role-detail">' +
          '  <div class="kickoff-detail-label">⚠️ Risks</div>' +
          '  <ul class="kickoff-detail-list kickoff-risks">' +
             a.risks.map(function (r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("") +
          "  </ul>" +
          "</div>";
      }

      var depsHtml = "";
      if (Array.isArray(a.dependencies) && a.dependencies.length > 0) {
        depsHtml =
          '<div class="kickoff-role-detail">' +
          '  <div class="kickoff-detail-label">🔗 Dependencies</div>' +
          '  <div class="kickoff-deps">' +
             a.dependencies.map(function (d) { return '<span class="kickoff-dep-chip">' + escapeHtml(d) + "</span>"; }).join("") +
          "  </div>" +
          "</div>";
      }

      return (
        '<div class="kickoff-role-card ' + statusCls + '">' +
        '  <div class="kickoff-role-header">' +
        '    <span class="kickoff-role-icon">' + icon + "</span>" +
        '    <span class="kickoff-role-name">' + escapeHtml(a.role) + "</span>" +
        '    <span class="kickoff-role-badge ' + statusCls + '">' + statusLabel + "</span>" +
        "  </div>" +
        scopeHtml +
        tasksHtml +
        risksHtml +
        depsHtml +
        "</div>"
      );
    }).join("");

    var summaryHtml = "";
    if (kickoffPlan.summary) {
      summaryHtml =
        '<div class="kickoff-summary">' +
        '  <div class="kickoff-summary-label">Discussion Summary</div>' +
        '  <div class="kickoff-summary-body markdown-body">' + renderMarkdownContent(kickoffPlan.summary) + "</div>" +
        "</div>";
    }

    return (
      '<div class="controller-run-section">' +
      '  <div class="kickoff-panel">' +
      header +
      '    <div class="kickoff-role-grid">' + roleCards + "</div>" +
      summaryHtml +
      "  </div>" +
      "</div>"
    );
  }

  // ── Planning Tab ───────────────────────────────────────────────────────
  var selectedPlanningRunId = null;

  function renderPlanningTab(runs) {
    var sessionList = $("#planning-session-list");
    if (!sessionList) return;

    var planningRuns = (runs || [])
      .filter(function (r) { return r && r.manifest; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });

    if (planningRuns.length === 0) {
      sessionList.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.noPlanningSessions")) + "</div>";
      showPlanningEmpty();
      return;
    }

    // Auto-select first if nothing selected or selection is gone
    if (!selectedPlanningRunId || !planningRuns.some(function (r) { return r.id === selectedPlanningRunId; })) {
      selectedPlanningRunId = planningRuns[0].id;
    }

    sessionList.innerHTML = planningRuns.map(function (run) {
      var manifest = run.manifest || {};
      var kp = manifest.kickoffPlan || {};
      var assessments = kp.assessments || [];
      var needed = assessments.filter(function (a) { return a.needed; }).length;
      var roles = (manifest.requiredRoles || []).length;
      var isActive = run.id === selectedPlanningRunId;
      var status = String(run.status || "active");
      var title = manifest.requirementSummary || run.title || "Untitled";
      if (title.length > 60) title = title.slice(0, 57) + "…";

      return (
        '<button type="button" class="planning-session-btn' + (isActive ? " active" : "") + '" data-planning-run="' + escapeHtml(run.id) + '">' +
        '  <div class="planning-session-title-row"><span class="planning-session-status ' + escapeHtml(status) + '"></span><div class="planning-session-title">' + escapeHtml(title) + "</div></div>" +
        '  <div class="planning-session-meta">' + escapeHtml(humanizeStatus(status)) + " · " + roles + " roles" + (assessments.length ? " · " + needed + " confirmed" : "") + " · " + escapeHtml(formatTime(run.updatedAt) || "") + "</div>" +
        "</button>"
      );
    }).join("");

    // Render selected run
    renderPlanningDetail(planningRuns.find(function (r) { return r.id === selectedPlanningRunId; }));
  }

  function showPlanningEmpty() {
    var empty = $("#planning-empty");
    var split = $("#planning-split");
    if (empty) empty.style.display = "";
    if (split) split.style.display = "none";
  }

  function renderPlanningDetail(run) {
    var empty = $("#planning-empty");
    var split = $("#planning-split");
    var reqEl = $("#planning-requirement");
    var kickoffEl = $("#planning-kickoff");

    if (!run || !run.manifest) {
      showPlanningEmpty();
      return;
    }

    if (empty) empty.style.display = "none";
    if (split) split.style.display = "";

    // Left pane: requirement + manifest summary
    if (reqEl) {
      var manifest = run.manifest;
      var reqLines = [];
      reqLines.push('<h3>' + escapeHtml(manifest.requirementSummary || run.title || "") + '</h3>');
      reqLines.push('<div class="planning-req-original">' + renderMarkdownContent(run.request || "") + '</div>');

      // Manifest details
      if (manifest.requiredRoles && manifest.requiredRoles.length) {
        reqLines.push('<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.requiredRoles")) + "</div>");
        reqLines.push('<div class="kickoff-deps">' + manifest.requiredRoles.map(function (r) {
          var icon = ROLE_ICONS[r] || "👤";
          return '<span class="kickoff-dep-chip">' + icon + " " + escapeHtml(r) + "</span>";
        }).join("") + "</div></div>");
      }

      var created = Array.isArray(manifest.createdTasks) ? manifest.createdTasks : [];
      var deferred = Array.isArray(manifest.deferredTasks) ? manifest.deferredTasks : [];
      if (created.length) {
        reqLines.push('<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.plannedTasks")) + " (" + created.length + ")</div>");
        reqLines.push('<ul class="planning-task-list">');
        created.forEach(function (t) {
          var roleLabel = t.assignedRole ? ' <span class="planning-role-tag">' + escapeHtml(t.assignedRole) + "</span>" : "";
          reqLines.push("<li>" + escapeHtml(t.title || "Task") + roleLabel + "</li>");
        });
        reqLines.push("</ul></div>");
      }
      if (deferred.length) {
        reqLines.push('<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.deferredTasks")) + " (" + deferred.length + ")</div>");
        reqLines.push('<ul class="planning-task-list planning-deferred">');
        deferred.forEach(function (t) {
          var roleLabel = t.assignedRole ? ' <span class="planning-role-tag">' + escapeHtml(t.assignedRole) + "</span>" : "";
          reqLines.push("<li>" + escapeHtml(t.title || "Task") + roleLabel + "</li>");
        });
        reqLines.push("</ul></div>");
      }
      if (Array.isArray(manifest.clarificationQuestions) && manifest.clarificationQuestions.length) {
        reqLines.push('<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.clarificationsNeeded")) + "</div>");
        reqLines.push('<ul class="planning-task-list planning-deferred">');
        manifest.clarificationQuestions.forEach(function (question) {
          reqLines.push("<li>" + escapeHtml(question) + "</li>");
        });
        reqLines.push("</ul></div>");
      }
      if (manifest.handoffPlan) {
        reqLines.push('<div class="planning-req-section"><div class="planning-req-label">Handoff Plan</div>');
        reqLines.push('<div class="planning-req-body markdown-body">' + renderMarkdownContent(manifest.handoffPlan) + "</div></div>");
      }
      if (manifest.notes) {
        reqLines.push('<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.notes")) + "</div>");
        reqLines.push('<div class="planning-req-body markdown-body">' + renderMarkdownContent(manifest.notes) + "</div></div>");
      }

      reqEl.innerHTML = reqLines.join("");
    }

    // Right pane: kickoff meeting or generic controller output
    if (kickoffEl) {
      if (run.manifest.kickoffPlan) {
        kickoffEl.innerHTML = renderKickoffContent(run.manifest.kickoffPlan);
      } else {
        kickoffEl.innerHTML =
          '<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.originalRequest")) + '</div><div class="planning-req-body markdown-body">' + renderMarkdownContent(run.request || "") + "</div></div>" +
          '<div class="planning-req-section"><div class="planning-req-label">' + escapeHtml(t("planning.controllerOutput")) + '</div><div class="planning-req-body markdown-body">' + renderMarkdownContent(run.reply || t("planning.noControllerOutput")) + "</div></div>";
      }
    }
  }

  function renderKickoffContent(kp) {
    if (!kp || !Array.isArray(kp.assessments) || kp.assessments.length === 0) {
      return '<div class="empty-state">' + escapeHtml(t("empty.noKickoffData")) + "</div>";
    }

    var assessments = kp.assessments;
    var html = [];

    // Stats bar
    var needed = assessments.filter(function (a) { return a.needed; }).length;
    var dismissed = assessments.length - needed;
    html.push(
      '<div class="kickoff-stats-bar">' +
      '  <div class="kickoff-stat"><span class="kickoff-stat-num">' + assessments.length + '</span><span class="kickoff-stat-label">Assessed</span></div>' +
      '  <div class="kickoff-stat kickoff-stat-ok"><span class="kickoff-stat-num">' + needed + '</span><span class="kickoff-stat-label">Confirmed</span></div>' +
      (dismissed > 0 ? '  <div class="kickoff-stat kickoff-stat-dim"><span class="kickoff-stat-num">' + dismissed + '</span><span class="kickoff-stat-label">Dismissed</span></div>' : "") +
      "</div>"
    );

    // Role cards
    assessments.forEach(function (a) {
      var icon = ROLE_ICONS[a.role] || "👤";
      var statusCls = a.needed ? "kickoff-role-needed" : "kickoff-role-dismissed";
      var statusLabel = a.needed ? "Confirmed" : "Not Needed";

      var sections = [];

      if (a.scope) {
        sections.push(
          '<div class="kickoff-role-scope"><div class="markdown-body">' + renderMarkdownContent(a.scope) + "</div></div>"
        );
      }

      if (Array.isArray(a.suggestedTasks) && a.suggestedTasks.length > 0) {
        sections.push(
          '<details class="kickoff-collapsible" open>' +
          '  <summary class="kickoff-detail-label">📋 Suggested Tasks (' + a.suggestedTasks.length + ")</summary>" +
          '  <ul class="kickoff-detail-list">' +
             a.suggestedTasks.map(function (t) { return "<li>" + escapeHtml(t) + "</li>"; }).join("") +
          "  </ul>" +
          "</details>"
        );
      }

      if (Array.isArray(a.risks) && a.risks.length > 0) {
        sections.push(
          '<details class="kickoff-collapsible">' +
          '  <summary class="kickoff-detail-label">⚠️ Risks (' + a.risks.length + ")</summary>" +
          '  <ul class="kickoff-detail-list kickoff-risks">' +
             a.risks.map(function (r) { return "<li>" + escapeHtml(r) + "</li>"; }).join("") +
          "  </ul>" +
          "</details>"
        );
      }

      if (Array.isArray(a.dependencies) && a.dependencies.length > 0) {
        sections.push(
          '<details class="kickoff-collapsible">' +
          '  <summary class="kickoff-detail-label">🔗 Dependencies (' + a.dependencies.length + ")</summary>" +
          '  <div class="kickoff-deps">' +
             a.dependencies.map(function (d) { return '<span class="kickoff-dep-chip">' + escapeHtml(d) + "</span>"; }).join("") +
          "  </div>" +
          "</details>"
        );
      }

      html.push(
        '<div class="kickoff-role-card ' + statusCls + '">' +
        '  <div class="kickoff-role-header">' +
        '    <span class="kickoff-role-icon">' + icon + "</span>" +
        '    <span class="kickoff-role-name">' + escapeHtml(a.role) + "</span>" +
        '    <span class="kickoff-role-badge ' + statusCls + '">' + statusLabel + "</span>" +
        "  </div>" +
        sections.join("") +
        "</div>"
      );
    });

    // Summary
    if (kp.summary) {
      html.push(
        '<div class="kickoff-summary">' +
        '  <div class="kickoff-summary-label">Discussion Summary</div>' +
        '  <div class="kickoff-summary-body markdown-body">' + renderMarkdownContent(kp.summary) + "</div>" +
        "</div>"
      );
    }

    return html.join("");
  }

  function buildMessageDisplayContent(message) {
    const content = normalizeTextValue(message && message.content);
    const contract = message && message.contract ? message.contract : null;
    if (!contract || !normalizeTextValue(contract.summary)) {
      return renderMarkdownContent(content);
    }
    const detailContent = normalizeTextValue(contract.details || "");
    if (!content || content === normalizeTextValue(contract.summary) || content === detailContent) {
      return "";
    }
    return renderMarkdownContent(message.content || "");
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

  /** Merge lazy-loaded children into the workspace tree data model. */
  function mergeWorkspaceSubtree(dirPath, entries) {
    var dirNode = findWorkspaceNodeByPath(workspaceTree, dirPath);
    if (dirNode && dirNode.type === "directory") {
      dirNode.children = entries;
    }
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
    // Non-blocking toast instead of a native alert(): native dialogs freeze
    // the page and steal focus, and multiple rapid errors queue up behind
    // each other. Toasts stack, auto-dismiss, and are click-dismissible.
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2000;display:flex;flex-direction:column;gap:10px;max-width:min(420px,80vw);";
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.className = "app-toast app-toast-error";
    toast.style.cssText = "background:#7f1d1d;color:#fff;padding:12px 16px;border-radius:10px;"
      + "box-shadow:0 8px 24px rgba(0,0,0,0.35);font-size:13px;line-height:1.45;"
      + "cursor:pointer;opacity:0;transition:opacity 0.25s ease;";
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(function () { toast.style.opacity = "1"; });
    const dismiss = function () {
      toast.style.opacity = "0";
      setTimeout(function () { toast.remove(); }, 250);
    };
    toast.onclick = dismiss;
    setTimeout(dismiss, 5000);
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
      if (settings.keepView && selectedWorkspaceView === "preview" && isWorkspacePreviewAvailable(selectedWorkspaceFile)) {
        // User explicitly chose preview and new file supports it — keep preview
      } else {
        // Default: md/html show preview, everything else shows source
        selectedWorkspaceView = isWorkspacePreviewAvailable(selectedWorkspaceFile) ? "preview" : "source";
      }
      updateWorkspaceTreeSelection();
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
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.workspaceLoading")) + "</div>";
      return;
    }

    if (!nodes || nodes.length === 0) {
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.noWorkspaceFiles")) + "</div>";
      return;
    }

    // Capture currently expanded directories before re-render
    var expandedDirs = new Set();
    var toggles = container.querySelectorAll(".workspace-tree-dir-toggle");
    for (var i = 0; i < toggles.length; i++) {
      var toggle = toggles[i];
      var li = toggle.closest(".workspace-tree-folder");
      var children = li ? li.querySelector(".workspace-tree-children") : null;
      if (children && children.style.display !== "none") {
        expandedDirs.add(toggle.dataset.dirPath);
      }
    }

    container.innerHTML = renderWorkspaceTreeNodes(nodes);

    // Restore expanded directories
    if (expandedDirs.size > 0) {
      var newToggles = container.querySelectorAll(".workspace-tree-dir-toggle");
      for (var j = 0; j < newToggles.length; j++) {
        var toggleEl = newToggles[j];
        if (expandedDirs.has(toggleEl.dataset.dirPath)) {
          var parentLi = toggleEl.closest(".workspace-tree-folder");
          var childrenDiv = parentLi ? parentLi.querySelector(".workspace-tree-children") : null;
          if (childrenDiv) {
            childrenDiv.style.display = "";
            var arrow = toggleEl.querySelector(".workspace-tree-arrow");
            if (arrow) arrow.textContent = "▾";
          }
        }
      }
    }
  }

  function renderWorkspaceTreeNodes(nodes) {
    return '<ul class="workspace-tree-list">' + nodes.map(function (node) {
      if (node.type === "directory") {
        const hasChildren = node.children && node.children.length > 0;
        const isLazy = !node.children; // children === undefined means not yet loaded
        return (
          '<li class="workspace-tree-folder">' +
          '  <div class="workspace-tree-dir-toggle' + (isLazy ? ' is-lazy' : '') + '" data-dir-path="' + escapeHtml(node.path) + '">' +
          '    <span class="workspace-tree-arrow">▸</span>' +
          '    <span class="workspace-tree-label">' + escapeHtml(node.name) + "</span>" +
          "  </div>" +
          '  <div class="workspace-tree-children" style="display:none">' +
              (hasChildren ? renderWorkspaceTreeNodes(node.children) : '') +
          "  </div>" +
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

  /** Update only the selected highlight in the tree without re-rendering (preserves expand state). */
  function updateWorkspaceTreeSelection() {
    var container = $("#workspace-tree");
    if (!container) return;
    var buttons = container.querySelectorAll(".workspace-tree-file");
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var isSelected = btn.dataset.workspacePath === selectedWorkspacePath;
      btn.classList.toggle("is-selected", isSelected);
    }
  }

  function renderWorkspaceFile() {
    const fileName = $("#workspace-file-name");
    const fileMeta = $("#workspace-file-meta");
    const openRaw = $("#workspace-open-raw");

    if (fileName) {
      fileName.textContent = selectedWorkspaceFile ? selectedWorkspaceFile.name : t("workspace.selectFile");
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
      container.innerHTML = '<div class="workspace-preview-empty">' + escapeHtml(t("empty.selectFileSource")) + "</div>";
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
      container.innerHTML = '<div class="workspace-preview-empty">' + escapeHtml(t("empty.selectFilePreview")) + "</div>";
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
    if (isConnecting) {
      return;
    }
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${location.host}/ws`;

    isConnecting = true;
    setStatus("connecting");
    ws = new WebSocket(wsUrl);

    ws.onopen = function () {
      isConnecting = false;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setStatus("connected");
      refreshAll();
    };

    ws.onclose = function () {
      isConnecting = false;
      setStatus("disconnected");
      scheduleReconnect();
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

  function scheduleReconnect() {
    if (reconnectTimer || isConnecting) {
      return;
    }
    reconnectAttempts += 1;
    const delay = Math.min(10000, 1000 * Math.max(1, reconnectAttempts));
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function setStatus(status) {
    const dot = $("#connection-status");
    if (dot) {
      dot.className = "status-dot " + status;
    }
  }

  /* function renmderRuntimeAlert(modelReadiness) keeps the legacy marker: TeamClaw is installed but cannot work yet. */
  function renderRuntimeAlert() {
    var alertEl = $("#runtime-alert");
    if (!alertEl) return;
    var readiness = teamState.modelReadiness;
    if (!readiness || readiness.status === "ready") {
      alertEl.classList.add("hidden");
      alertEl.innerHTML = "";
      return;
    }
    var detailBits = [];
    if (!readiness.hasConfiguredModel) {
      detailBits.push(t("runtime.noModel"));
    }
    if (!readiness.hasAuthProfiles) {
      detailBits.push(t("runtime.noAuth"));
    }
    alertEl.classList.remove("hidden");
    alertEl.innerHTML = (
      "<strong>" + escapeHtml(t("runtime.title")) + "</strong> " +
      escapeHtml(readiness.message || detailBits.join(" ")) +
      (detailBits.length ? (" " + escapeHtml(detailBits.join(" "))) : "")
    );
  }

  function renderExternalWorkerInstallToggle() {
    var button = $("#worker-install-toggle");
    if (!button) return;
    var available = Boolean(teamState.externalWorkerInstall);
    button.hidden = !available;
    button.disabled = !available;
    button.textContent = externalWorkerInstallVisible ? t("worker.hide") : t("worker.add");
    // Source-contract note: keep the legacy English marker after externalWorkerInstallVisible: Add worker.
  }

  function buildExternalWorkerCommand(info, roleId, discoveryMode) {
    if (!info || !roleId) return "";
    var prefix = discoveryMode === "manual" ? (info.manualCommandPrefix || "") : (info.autoDiscoveryCommandPrefix || "");
    var suffix = discoveryMode === "manual" ? (info.manualControllerUrlFlag || "") : "";
    return (prefix + roleId + suffix).trim();
  }

  function renderExternalWorkerInstallCard() {
    // Source-contract note: keep the legacy English markers "Register a new external worker" and "Copy command".
    var card = $("#external-worker-install");
    if (!card) return;
    var info = teamState.externalWorkerInstall;
    if (!info || !externalWorkerInstallVisible) {
      card.classList.add("hidden");
      return;
    }
    var roles = Array.isArray(info.roles) ? info.roles : [];
    if (!roles.length) {
      card.classList.add("hidden");
      card.innerHTML = "";
      return;
    }
    if (!roles.some(function (role) { return role.id === selectedExternalWorkerRole; })) {
      selectedExternalWorkerRole = roles[0].id;
    }
    if (selectedExternalWorkerDiscoveryMode === "manual" && !info.recommendedControllerUrl) {
      selectedExternalWorkerDiscoveryMode = "mdns";
    }
    var roleOptions = roles.map(function (role) {
      return '<option value="' + escapeHtml(role.id) + '"' + (role.id === selectedExternalWorkerRole ? " selected" : "") + ">" +
        escapeHtml((role.icon ? role.icon + " " : "") + (role.label || role.id)) +
        "</option>";
    }).join("");
    var command = buildExternalWorkerCommand(info, selectedExternalWorkerRole, selectedExternalWorkerDiscoveryMode);
    var discoveryOptions = [
      '<option value="mdns"' + (selectedExternalWorkerDiscoveryMode === "mdns" ? " selected" : "") + ">" + escapeHtml(t("worker.discoveryMdns")) + "</option>",
      '<option value="manual"' + (selectedExternalWorkerDiscoveryMode === "manual" ? " selected" : "") + (info.recommendedControllerUrl ? "" : " disabled") + ">" + escapeHtml(t("worker.discoveryManual")) + "</option>",
    ].join("");
    var note = selectedExternalWorkerDiscoveryMode === "manual"
      ? (info.manualControllerWarning || "")
      : (info.autoDiscoveryWarning || "");
    var manualDetail = selectedExternalWorkerDiscoveryMode === "manual" && info.recommendedControllerUrl
      ? '<div class="worker-install-note">' + escapeHtml(t("worker.recommendedUrl")) + '<code>' + escapeHtml(info.recommendedControllerUrl) + "</code></div>"
      : "";
    card.classList.remove("hidden");
    card.innerHTML = (
      '<div class="worker-install-head">' +
        '<div>' +
          "<h3>" + escapeHtml(t("worker.cardTitle")) + "</h3>" +
          '<div class="worker-install-subtitle">' + escapeHtml(t("worker.cardSubtitle")) + "</div>" +
        "</div>" +
        '<button type="button" class="worker-install-copy" data-worker-install-copy="true">' + escapeHtml(t("action.copyCommand")) + "</button>" +
      "</div>" +
      '<div class="worker-install-controls">' +
        '<div class="worker-install-field">' +
          '<label for="worker-install-role">' + escapeHtml(t("worker.role")) + "</label>" +
          '<select id="worker-install-role" data-worker-install-role="true">' + roleOptions + "</select>" +
        "</div>" +
        '<div class="worker-install-field">' +
          '<label for="worker-install-discovery">' + escapeHtml(t("worker.discovery")) + "</label>" +
          '<select id="worker-install-discovery" data-worker-install-discovery="true">' + discoveryOptions + "</select>" +
        "</div>" +
      "</div>" +
      '<pre class="worker-install-command"><code>' + escapeHtml(command) + "</code></pre>" +
      manualDetail +
      '<div class="worker-install-note' + (selectedExternalWorkerDiscoveryMode === "manual" ? " warning" : "") + '">' + escapeHtml(note) + "</div>"
    );
  }

  function renderActivitySignals() {
    var planningCount = activePlanningRunCount();
    var taskActive = activeTaskCount();
    var taskBlocked = blockedTaskCount();
    var clarificationCount = pendingClarifications().length;

    var planningBadge = $("#planning-tab-count");
    var tasksBadge = $("#tasks-tab-count");
    var clarificationsBadge = $("#clarifications-tab-count");
    var planningSignal = $("#planning-tab-signal");
    var tasksSignal = $("#tasks-tab-signal");
    var clarificationsSignal = $("#clarifications-tab-signal");
    var planningTab = $('[data-tab="planning"]');
    var tasksTab = $('[data-tab="tasks"]');
    var clarificationsTab = $('[data-tab="clarifications"]');

    if (planningBadge) {
      planningBadge.textContent = String(planningCount);
      planningBadge.className = "tab-badge" + (planningCount > 0 ? " tone-active" : "");
      planningBadge.style.display = planningCount > 0 ? "" : "none";
    }
    if (tasksBadge) {
      var taskCount = taskBlocked > 0 ? taskBlocked : taskActive;
      tasksBadge.textContent = String(taskCount);
      tasksBadge.className = "tab-badge" + (taskBlocked > 0 ? " tone-attention" : taskActive > 0 ? " tone-active" : "");
      tasksBadge.style.display = taskCount > 0 ? "" : "none";
    }
    if (clarificationsBadge) {
      clarificationsBadge.textContent = String(clarificationCount);
      clarificationsBadge.className = "tab-badge" + (clarificationCount > 0 ? " tone-attention" : "");
      clarificationsBadge.style.display = clarificationCount > 0 ? "" : "none";
    }
    if (planningSignal) {
      planningSignal.className = "tab-signal" + (planningCount > 0 ? " tone-active" : "");
    }
    if (tasksSignal) {
      tasksSignal.className = "tab-signal" + (taskBlocked > 0 ? " tone-attention" : taskActive > 0 ? " tone-active" : "");
    }
    if (clarificationsSignal) {
      clarificationsSignal.className = "tab-signal" + (clarificationCount > 0 ? " tone-attention" : "");
    }
    if (planningTab) {
      planningTab.classList.toggle("has-active", planningCount > 0);
      planningTab.classList.toggle("has-attention", false);
    }
    if (tasksTab) {
      tasksTab.classList.toggle("has-active", taskActive > 0);
      tasksTab.classList.toggle("has-attention", taskBlocked > 0);
    }
    if (clarificationsTab) {
      clarificationsTab.classList.toggle("has-active", false);
      clarificationsTab.classList.toggle("has-attention", clarificationCount > 0);
    }
  }

  function syncClarificationPrompt(options) {
    var pending = pendingClarifications();
    dismissedClarificationIds = dismissedClarificationIds.filter(function (id) {
      return pending.some(function (item) { return item.id === id; });
    });

    if (pending.length === 0) {
      clarificationPromptOpen = false;
      activeClarificationId = null;
      renderClarificationPrompt();
      return;
    }

    var active = pending.find(function (item) { return item.id === activeClarificationId; });
    if (!active) {
      active = pending.find(function (item) { return dismissedClarificationIds.indexOf(item.id) === -1; }) || pending[0];
      activeClarificationId = active ? active.id : null;
    }

    if (!clarificationPromptOpen && active && dismissedClarificationIds.indexOf(active.id) === -1) {
      clarificationPromptOpen = true;
    }

    if (options && options.forceOpen && active) {
      clarificationPromptOpen = true;
      activeClarificationId = active.id;
    }

    renderClarificationPrompt();
  }

  function renderClarificationPrompt() {
    var modal = $("#clarification-prompt-modal");
    var body = $("#clarification-prompt-body");
    if (!modal || !body) return;

    var pending = pendingClarifications();
    var active = pending.find(function (item) { return item.id === activeClarificationId; });
    if (!clarificationPromptOpen || !active) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
      return;
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    body.innerHTML = renderClarificationCards([active], { compact: false, linkToTask: true });
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
      case "report:ready":
        handleReportReady(event.data || {});
        break;
    }
  }

  function handleReportReady(data) {
    const reportUrl = data.reportUrl;
    const projectName = data.projectName || "Project";
    const status = data.status || "completed";
    const icon = status === "completed" ? "✅" : status === "partial" ? "⚠️" : "❌";

    // Create toast notification
    let container = document.getElementById("toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      container.style.cssText = "position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.style.cssText = "background:#1a365d;color:#fff;padding:14px 20px;border-radius:10px;"
      + "box-shadow:0 8px 24px rgba(0,0,0,.2);font-size:14px;max-width:380px;"
      + "animation:slideIn .3s ease;cursor:pointer;display:flex;flex-direction:column;gap:6px;";
    toast.innerHTML = '<div style="font-weight:600;">' + icon + " Delivery Report Ready</div>"
      + '<div style="opacity:.85;font-size:13px;">' + escapeHtmlInline(projectName) + " — " + status + "</div>"
      + '<div style="font-size:12px;opacity:.7;">Click to open report</div>';
    toast.onclick = function () {
      if (reportUrl) window.open(reportUrl, "_blank");
      toast.remove();
    };

    container.appendChild(toast);
    setTimeout(function () { toast.style.opacity = "0"; toast.style.transition = "opacity .5s"; }, 8000);
    setTimeout(function () { toast.remove(); }, 8500);

    // Add animation keyframes if not already present
    if (!document.getElementById("toast-anim-style")) {
      const style = document.createElement("style");
      style.id = "toast-anim-style";
      style.textContent = "@keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }";
      document.head.appendChild(style);
    }
  }

  function escapeHtmlInline(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function refreshAll() {
    try {
      const statusRes = await apiGet("/team/status");
      let rolesRes = { roles: [] };
      try {
        rolesRes = await apiGet("/roles");
      } catch (rolesErr) {
        console.error("Failed to load roles:", rolesErr);
      }

      teamState = {
        workers: statusRes.workers || [],
        tasks: statusRes.tasks || [],
        controllerRuns: statusRes.controllerRuns || [],
        messages: statusRes.messages || [],
        clarifications: statusRes.clarifications || [],
        modelReadiness: statusRes.modelReadiness || null,
        externalWorkerInstall: statusRes.externalWorkerInstall || null,
      };

      renderWorkers(teamState.workers);
      renderTasks(teamState.tasks);
      renderPlanningTab(teamState.controllerRuns);
      renderControllerRuns(teamState.controllerRuns);
      renderClarifications(teamState.clarifications);
      renderMessages(teamState.messages);
      renderRoles(rolesRes.roles || []);
      renderRuntimeAlert();
      renderExternalWorkerInstallToggle();
      renderExternalWorkerInstallCard();
      renderActivitySignals();
      syncClarificationPrompt();

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
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.noWorkers")) + "</div>";
      return;
    }

    container.innerHTML = workers.map(function (worker) {
      var staleBadge = worker.staleRemovable
        ? '<span class="worker-status stale" title="Ghost record from a previous gateway process">stale</span>'
        : "";
      return (
        '<div class="worker-card' + (worker.staleRemovable ? " worker-card-stale" : "") + '" data-worker-id="' + escapeHtml(worker.id) + '">' +
        '  <span class="worker-icon">' + escapeHtml(worker.label || worker.role).charAt(0) + '</span>' +
        '  <span class="worker-label">' + escapeHtml(worker.label || worker.role) + '</span>' +
        '  <span class="worker-status ' + escapeHtml(worker.status || "offline") + '">' + escapeHtml(worker.status || "offline") + "</span>" +
        staleBadge +
        (worker.staleRemovable
          ? '<button class="btn btn-small worker-remove-btn" type="button" data-remove-worker="' + escapeHtml(worker.id) + '">Remove</button>'
          : "") +
        "</div>"
      );
    }).join("");

    container.querySelectorAll("[data-remove-worker]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var workerId = btn.getAttribute("data-remove-worker");
        if (!workerId) return;
        btn.disabled = true;
        apiRequest("/workers/" + encodeURIComponent(workerId), { method: "DELETE" })
          .then(function () {
            showError("Removed stale worker record " + workerId);
            refreshAll();
          })
          .catch(function (err) { showError(err instanceof Error ? err.message : "Failed to remove worker"); btn.disabled = false; });
      });
    });
  }

  const TERMINAL_STATUSES = { completed: true, failed: true };
  const PRIORITY_WEIGHT = { critical: 0, high: 1, medium: 2, low: 3 };

  function taskComparator(left, right) {
    const terminalL = TERMINAL_STATUSES[left.status] ? 1 : 0;
    const terminalR = TERMINAL_STATUSES[right.status] ? 1 : 0;
    if (terminalL !== terminalR) { return terminalL - terminalR; }
    const prioL = PRIORITY_WEIGHT[left.priority || "medium"] ?? 2;
    const prioR = PRIORITY_WEIGHT[right.priority || "medium"] ?? 2;
    if (prioL !== prioR) { return prioL - prioR; }
    return (right.updatedAt || 0) - (left.updatedAt || 0);
  }

  function taskMatchesKeyword(task, keyword) {
    if (!keyword) { return true; }
    const haystack = [task.id, task.title, task.description, task.assignedRole, task.createdBy, task.assignedWorkerId]
      .filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(keyword);
  }

  function renderTasks(tasks) {
    const container = $("#tasks-board");
    if (!container) return;

    const filtered = (currentFilter === "all"
      ? tasks
      : tasks.filter(function (task) { return task.status === currentFilter; }))
      .filter(function (task) { return taskMatchesKeyword(task, taskKeywordFilter); });

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state">' + escapeHtml(
        taskKeywordFilter
          ? t("tasks.noMatch")
          : currentFilter !== "all"
            ? t("empty.noTasksWithStatus", { status: currentFilter })
            : t("empty.noTasks")
      ) + "</div>";
      return;
    }

    const sorted = filtered.slice().sort(taskComparator);
    // Active tasks render in full; terminal ones chunk so long-lived installs
    // with hundreds of completed tasks stay fast and meaningful.
    const activeTasks = sorted.filter(function (task) { return !TERMINAL_STATUSES[task.status]; });
    const terminalTasks = sorted.filter(function (task) { return TERMINAL_STATUSES[task.status]; });
    const visibleTerminal = terminalTasks.slice(0, terminalTasksVisible);
    const hiddenTerminal = terminalTasks.length - visibleTerminal.length;
    const visibleList = activeTasks.concat(visibleTerminal);

    const showMoreHtml = hiddenTerminal > 0
      ? '<button id="tasks-show-more" class="btn btn-small tasks-show-more" type="button">' + escapeHtml(t("tasks.showMore", { n: hiddenTerminal })) + "</button>"
      : "";

    container.innerHTML = visibleList.map(function (task) {
      const priority = task.priority || "medium";
      const status = task.status || "pending";
      const assignee = task.assignedWorkerId
        ? "Assigned to " + task.assignedWorkerId
        : (task.assignedRole ? "Role: " + task.assignedRole : "Unassigned");
      const recommendedSkills = normalizeSkillList(task.recommendedSkills);
      const creatorBadge = task.createdBy
        ? '<span class="task-origin-badge">' + escapeHtml(task.createdBy) + "</span>"
        : "";
      const contractSummary = task.resultContract
        ? '<div class="task-contract-summary"><strong>Result:</strong> ' + escapeHtml(task.resultContract.summary || "") + "</div>"
        : task.lastHandoff
          ? '<div class="task-contract-summary"><strong>Handoff:</strong> ' + escapeHtml(task.lastHandoff.summary || "") + "</div>"
          : task.progressContract
            ? '<div class="task-contract-summary"><strong>Progress:</strong> ' + escapeHtml(task.progressContract.summary || "") + "</div>"
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
        contractSummary +
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
    }).join("") + showMoreHtml;

    const showMoreBtn = $("#tasks-show-more");
    if (showMoreBtn) {
      showMoreBtn.addEventListener("click", function () {
        terminalTasksVisible += 20;
        renderTasks(teamState.tasks || []);
      });
    }
  }

  function renderControllerRuns(runs) {
    const container = $("#controller-runs");
    if (!container) return;

    const recentRuns = (runs || [])
      .slice()
      .sort(function (left, right) { return (right.updatedAt || 0) - (left.updatedAt || 0); })
      .slice(0, 12);

    if (recentRuns.length === 0) {
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.noControllerActivity")) + "</div>";
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
      const manifestBlock = run.manifest
        ? '<div class="controller-run-section"><div class="controller-run-section-title">Manifest</div>' + renderControllerManifestCard(run.manifest) + "</div>"
        : "";
      const kickoffBlock = run.manifest && run.manifest.kickoffPlan
        ? renderKickoffMeetingPanel(run.manifest.kickoffPlan)
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
        manifestBlock +
        kickoffBlock +
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
    selectedTaskDetailTab = "details";
    taskTimelineAutoFollow = true;
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
    selectedTaskDetailTab = "details";
    taskTimelineAutoFollow = true;
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
      title.textContent = task ? task.title : t("empty.selectTask");
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

    renderTaskDetailTabCounts(task);
    renderTaskDetailOverview(task);
    renderTaskDetailTimeline(task);
    renderTaskDetailClarifications();
    renderTaskDetailMessages();
    syncTaskDetailTab();
    if (selectedTaskDetailTab === "timeline" && taskTimelineAutoFollow) {
      requestAnimationFrame(scrollTaskTimelineToBottom);
    }
  }

  function renderTaskDetailOverview(task) {
    const container = $("#task-detail-details");
    if (!container) return;

    if (!task) {
      container.innerHTML = '<div class="task-detail-empty">' + escapeHtml(t("empty.taskDetail")) + "</div>";
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
      (task.progressContract
        ? '<div class="task-detail-section"><h3>Structured Progress</h3>' + renderProgressContractCard(task.progressContract) + "</div>"
        : "") +
      (task.result
        ? '<div class="task-detail-section"><h3>Result</h3>' + renderMarkdownCard(task.result) + "</div>"
        : "") +
      (task.resultContract
        ? '<div class="task-detail-section"><h3>Structured Result</h3>' + renderResultContractCard(task.resultContract) + "</div>"
        : "") +
      (task.lastHandoff
        ? '<div class="task-detail-section"><h3>Last Handoff</h3>' + renderHandoffContractCard(task.lastHandoff) + "</div>"
        : "") +
      (task.error
        ? '<div class="task-detail-section"><h3>Error</h3>' + renderMarkdownCard(task.error) + "</div>"
        : "");
  }

  function renderTaskDetailTabCounts(task) {
    var counts = {
      details: task ? 1 : 0,
      timeline: normalizeArray(getSelectedTaskExecution().events).length,
      clarifications: normalizeArray(selectedTaskDetail && selectedTaskDetail.clarifications).length,
      messages: normalizeArray(selectedTaskDetail && selectedTaskDetail.messages).length,
    };
    $$("[data-task-detail-tab-count]").forEach(function (node) {
      var name = node.dataset.taskDetailTabCount || "";
      var count = counts[name] || 0;
      node.textContent = count > 0 ? String(count) : "";
      node.className = "task-detail-tab-count" + (count > 0 ? " has-items" : "");
    });
  }

  function scrollTaskTimelineToBottom() {
    var container = $("#task-detail-timeline");
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }

  function syncTaskTimelineFollowState() {
    if (selectedTaskDetailTab !== "timeline") return;
    var container = $("#task-detail-timeline");
    if (!container) return;
    taskTimelineAutoFollow = isNearBottom(container);
  }

  function renderMessageCards(messages) {
    return normalizeArray(messages).map(function (message) {
      const from = message.fromRole || message.from || "unknown";
      const type = (message.contract && message.contract.intent) || message.type || "direct";
      const contractBlock = renderTeamMessageContractCard(message.contract);
      const rawContent = buildMessageDisplayContent(message);
      const meta = [
        message.toRole ? ("to " + message.toRole) : null,
        message.taskId ? ("task " + message.taskId) : null,
        formatTime(message.createdAt),
      ].filter(Boolean).join(" • ");

      return (
        '<div class="message-card">' +
        '  <div class="message-header">' +
        '    <span class="message-from">' + escapeHtml(from) + "</span>" +
        '    <span class="message-type ' + escapeHtml(type) + '">' + escapeHtml(humanizeStatus(type)) + "</span>" +
        "  </div>" +
        (meta ? '<div class="message-meta">' + escapeHtml(meta) + "</div>" : "") +
        contractBlock +
        (rawContent ? '<div class="message-content markdown-body">' + rawContent + "</div>" : "") +
        "</div>"
      );
    }).join("");
  }

  function renderClarificationCards(items, options) {
    var opts = options || {};
    return normalizeArray(items).map(function (item) {
      const status = item.status || "pending";
      const context = item.context
        ? '<div class="clarification-context"><strong>Context:</strong> ' + escapeHtml(item.context) + "</div>"
        : "";
      const taskLink = opts.linkToTask && item.taskId
        ? '<button type="button" class="btn btn-small" data-open-task-id="' + escapeHtml(item.taskId) + '">Open task</button>'
        : "";
      const answerBlock = status === "pending"
        ? (
          '<form class="clarification-answer-form" data-clarification-id="' + escapeHtml(item.id) + '">' +
          '  <label class="clarification-label" for="answer-' + escapeHtml(item.id) + '">Answer as human</label>' +
          '  <textarea id="answer-' + escapeHtml(item.id) + '" name="answer" rows="3" placeholder="Type the exact clarification answer..." required></textarea>' +
          '  <div class="clarification-actions">' +
          taskLink +
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
        '<div class="clarification-card' + (opts.compact ? " clarification-card-compact" : "") + '">' +
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

  function renderTaskDetailClarifications() {
    var container = $("#task-detail-clarifications");
    if (!container) return;
    var items = normalizeArray(selectedTaskDetail && selectedTaskDetail.clarifications);
    if (!items.length) {
      container.innerHTML = '<div class="task-detail-empty">No clarifications on this task.</div>';
      return;
    }
    container.innerHTML = '<div class="clarifications-list">' + renderClarificationCards(items, { linkToTask: false }) + "</div>";
  }

  function renderTaskDetailMessages() {
    var container = $("#task-detail-messages");
    if (!container) return;
    var items = normalizeArray(selectedTaskDetail && selectedTaskDetail.messages);
    if (!items.length) {
      container.innerHTML = '<div class="task-detail-empty">' + escapeHtml(t("empty.taskMessages")) + "</div>";
      return;
    }
    container.innerHTML = '<div class="messages-feed">' + renderMessageCards(items) + "</div>";
  }

  function buildTimelineMessageBody(message) {
    const contractBlock = renderTeamMessageContractCard(message && message.contract);
    const rawContent = buildMessageDisplayContent(message);
    return (contractBlock || "") + (rawContent ? '<div class="timeline-raw-markdown markdown-body">' + rawContent + "</div>" : "");
  }

  function buildTimelineClarificationBody(item) {
    const answerBlock = item && item.answer
      ? '<div class="timeline-contract-note"><strong>Answer:</strong> ' + renderMarkdownInline(item.answer) + "</div>"
      : "";
    const contextBlock = item && item.context
      ? '<div class="timeline-contract-note"><strong>Context:</strong> ' + renderMarkdownInline(item.context) + "</div>"
      : "";
    return (
      '<div class="timeline-contract-note"><strong>Question:</strong> ' + renderMarkdownInline(item.question || "") + "</div>" +
      '<div class="timeline-contract-note"><strong>Blocking Reason:</strong> ' + renderMarkdownInline(item.blockingReason || "") + "</div>" +
      contextBlock +
      answerBlock
    );
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
        bodyHtml: renderMarkdownContent(event.message || ""),
      };
    });

    const messages = (selectedTaskDetail.messages || []).map(function (message) {
      return {
        kind: "message",
        createdAt: message.createdAt || 0,
        label: humanizeStatus((message.contract && message.contract.intent) || message.type || "message"),
        meta: [
          message.fromRole || message.from || "unknown",
          message.toRole ? ("to " + message.toRole) : null,
          message.contract && message.contract.needsResponse ? "response expected" : null,
        ].filter(Boolean).join(" • "),
        bodyHtml: buildTimelineMessageBody(message),
      };
    });

    const clarifications = (selectedTaskDetail.clarifications || []).map(function (item) {
      return {
        kind: "clarification",
        createdAt: item.updatedAt || item.createdAt || 0,
        label: item.status === "answered" ? "clarification answered" : "clarification requested",
        meta: [
          item.requestedByRole || "unknown role",
          item.requestedByWorkerId || item.requestedBy || null,
        ].filter(Boolean).join(" • "),
        bodyHtml: buildTimelineClarificationBody(item),
      };
    });

    return executionEvents.concat(messages).concat(clarifications).sort(function (left, right) {
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
      container.innerHTML = '<div class="task-detail-empty">' + escapeHtml(t("empty.taskHistory")) + "</div>";
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
          '  <div class="timeline-entry-body markdown-body">' + (entry.bodyHtml || renderMarkdownContent(entry.body || "")) + "</div>" +
          "</article>"
        );
      }).join("") +
      "</div>";

    container.onscroll = syncTaskTimelineFollowState;
    if (taskTimelineAutoFollow) {
      requestAnimationFrame(scrollTaskTimelineToBottom);
    }
  }

  function syncTaskDetailTab() {
    $$(".task-detail-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.dataset.taskDetailTab === selectedTaskDetailTab);
    });
    ["details", "timeline", "clarifications", "messages"].forEach(function (name) {
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
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.noClarifications")) + "</div>";
      return;
    }

    container.innerHTML = renderClarificationCards(sortClarifications(clarifications), { linkToTask: true });
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
      container.innerHTML = '<div class="empty-state">' + escapeHtml(t("empty.noMessages")) + "</div>";
      return;
    }

    container.innerHTML = renderMessageCards(recent);
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

  function tabNameFromHash() {
    const match = /^#\/tab\/([a-z][a-z0-9-]*)$/i.exec(window.location.hash || "");
    const name = match ? match[1] : "";
    if (!name) { return ""; }
    // $$ returns a NodeList: it has forEach but NOT .some - convert first.
    const known = Array.from($$(".tab")).some(function (item) { return item.dataset.tab === name; });
    return known ? name : "";
  }

  function syncTabHash(tab) {
    try {
      const target = "#/tab/" + tab;
      if (window.location.hash !== target) {
        window.history.replaceState(null, "", target);
      }
    } catch (_err) {
      // Embedded/non-browser hosts without history API - hash is best-effort.
    }
  }

  function activateTab(nextTab) {
    activeTab = nextTab || "tasks";
    $$(".tab").forEach(function (item) {
      item.classList.toggle("active", item.dataset.tab === activeTab);
    });
    syncTabHash(activeTab);
    $$(".tab-panel").forEach(function (panel) { panel.classList.remove("active"); });
    const panel = $("#tab-" + activeTab);
    if (panel) {
      panel.classList.add("active");
    }
    if (activeTab === "workspace") {
      refreshWorkspaceTree(false);
    }
    if (activeTab === "teamauto") {
      refreshTeamAutoTab();
    }
    renderActivitySignals();
  }

  $$(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      activateTab(tab.dataset.tab || "tasks");
    });
  });

  // Hash deep links: boot on #/tab/<name> (refresh keeps the current tab) and
  // follow hashchange (browser back/forward between tabs).
  const bootTab = tabNameFromHash();
  if (bootTab) {
    activateTab(bootTab);
  }
  window.addEventListener("hashchange", function () {
    const fromHash = tabNameFromHash();
    if (fromHash && fromHash !== activeTab) {
      activateTab(fromHash);
    }
  });

  $$(".filter-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      $$(".filter-btn").forEach(function (item) { item.classList.remove("active"); });
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      terminalTasksVisible = 20;
      renderTasks(teamState.tasks || []);
    });
  });

  const taskKeywordInput = $("#task-keyword");
  if (taskKeywordInput) {
    taskKeywordInput.addEventListener("input", function () {
      taskKeywordFilter = taskKeywordInput.value.trim().toLowerCase();
      terminalTasksVisible = 20;
      renderTasks(teamState.tasks || []);
    });
  }

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
      if (!target) return;

      // Directory toggle (lazy-load on first expand)
      const dirToggle = target.closest(".workspace-tree-dir-toggle");
      if (dirToggle) {
        const li = dirToggle.closest(".workspace-tree-folder");
        if (!li) return;
        const childrenContainer = li.querySelector(".workspace-tree-children");
        if (!childrenContainer) return;
        const arrow = dirToggle.querySelector(".workspace-tree-arrow");
        const isOpen = childrenContainer.style.display !== "none";

        if (isOpen) {
          childrenContainer.style.display = "none";
          if (arrow) arrow.textContent = "▸";
        } else {
          childrenContainer.style.display = "";
          if (arrow) arrow.textContent = "▾";
          // Lazy-load if not yet loaded
          if (dirToggle.classList.contains("is-lazy")) {
            dirToggle.classList.remove("is-lazy");
            var dirPath = dirToggle.dataset.dirPath || "";
            childrenContainer.innerHTML = '<div class="workspace-tree-loading">Loading…</div>';
            apiGet("/workspace/subtree?path=" + encodeURIComponent(dirPath)).then(function (data) {
              var entries = data.entries || [];
              mergeWorkspaceSubtree(dirPath, entries);
              if (entries.length === 0) {
                childrenContainer.innerHTML = '<div class="workspace-tree-empty">(empty)</div>';
              } else {
                childrenContainer.innerHTML = renderWorkspaceTreeNodes(entries);
              }
            }).catch(function () {
              childrenContainer.innerHTML = '<div class="workspace-tree-empty">Failed to load</div>';
            });
          }
        }
        return;
      }

      // File click
      const button = target.closest("[data-workspace-path]");
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

  $$(".task-detail-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      selectedTaskDetailTab = tab.dataset.taskDetailTab || "details";
      if (selectedTaskDetailTab === "timeline") {
        taskTimelineAutoFollow = true;
      }
      syncTaskDetailTab();
      renderTaskDetail();
    });
  });

  const clarificationPromptClose = $("#clarification-prompt-close");
  if (clarificationPromptClose) {
    clarificationPromptClose.addEventListener("click", function () {
      if (activeClarificationId && dismissedClarificationIds.indexOf(activeClarificationId) === -1) {
        dismissedClarificationIds.push(activeClarificationId);
      }
      clarificationPromptOpen = false;
      renderClarificationPrompt();
    });
  }
  $$("[data-clarification-prompt-close]").forEach(function (node) {
    node.addEventListener("click", function () {
      if (activeClarificationId && dismissedClarificationIds.indexOf(activeClarificationId) === -1) {
        dismissedClarificationIds.push(activeClarificationId);
      }
      clarificationPromptOpen = false;
      renderClarificationPrompt();
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
      dismissedClarificationIds = dismissedClarificationIds.filter(function (id) { return id !== clarificationId; });
      if (activeClarificationId === clarificationId) {
        activeClarificationId = null;
      }
      refreshAll();
      if (selectedTaskId) {
        refreshTaskDetail(true);
      }
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

  var languageToggle = $("#language-toggle");
  if (languageToggle) {
    languageToggle.addEventListener("click", function () {
      setLanguage(currentLanguage === "zh" ? "en" : "zh");
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    var toggle = target ? target.closest("#worker-install-toggle") : null;
    if (toggle) {
      externalWorkerInstallVisible = !externalWorkerInstallVisible;
      renderExternalWorkerInstallToggle();
      renderExternalWorkerInstallCard();
      return;
    }
    var button = target ? target.closest("[data-open-task-id]") : null;
    var taskId = button && button.dataset ? button.dataset.openTaskId : "";
    if (!taskId || (controllerRunsContainer && controllerRunsContainer.contains(button))) {
      return;
    }
    activateTab("tasks");
    openTaskDetail(taskId);
  });

  document.addEventListener("change", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.matches("[data-worker-install-role]")) {
      selectedExternalWorkerRole = target.value || selectedExternalWorkerRole;
      renderExternalWorkerInstallCard();
      return;
    }
    if (target.matches("[data-worker-install-discovery]")) {
      selectedExternalWorkerDiscoveryMode = target.value === "manual" ? "manual" : "mdns";
      renderExternalWorkerInstallCard();
    }
  });

  document.addEventListener("click", function (event) {
    var target = event.target instanceof Element ? event.target : null;
    var button = target ? target.closest("[data-worker-install-copy]") : null;
    if (!button) return;
    var command = buildExternalWorkerCommand(
      teamState.externalWorkerInstall,
      selectedExternalWorkerRole,
      selectedExternalWorkerDiscoveryMode,
    );
    copyText(command).then(function () {
      button.textContent = t("action.copied");
      window.setTimeout(function () {
        button.textContent = t("action.copyCommand");
      }, 1200);
    }).catch(function (err) {
      console.error(err);
        showError(err instanceof Error ? err.message : "Failed to copy command");
    });
  });

  // Planning session sub-tab click handler
  var planningSessionList = $("#planning-session-list");
  if (planningSessionList) {
    planningSessionList.addEventListener("click", function (event) {
      var target = event.target instanceof Element ? event.target : null;
      var btn = target ? target.closest("[data-planning-run]") : null;
      var runId = btn && btn.dataset ? btn.dataset.planningRun : "";
      if (runId && runId !== selectedPlanningRunId) {
        selectedPlanningRunId = runId;
        renderPlanningTab(teamState.controllerRuns);
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
        content: data && data.reply ? data.reply : t("empty.copiedControllerReply"),
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

  async function applyInitialUiState() {
    if (initialUiStateApplied) {
      return;
    }
    initialUiStateApplied = true;

    if (initialUiState.planningRun) {
      selectedPlanningRunId = initialUiState.planningRun;
      renderPlanningTab(teamState.controllerRuns);
    }

    if (initialUiState.tab) {
      // Only activate a tab that actually exists (guards stale links).
      // Array.from: NodeList has no .some.
      const tabExists = Array.from($$(".tab")).some(function (item) { return item.dataset.tab === initialUiState.tab; });
      if (tabExists) {
        activateTab(initialUiState.tab);
      }
    }

    if (initialUiState.taskId) {
      await openTaskDetail(initialUiState.taskId);
    }
  }

  var WORKSPACE_PROMPT_DISMISSED_KEY = "teamclaw.workspacePromptDismissed";

  function updateWorkspacePathIndicator() {
    var el = $("#workspace-current-path-value");
    if (!el) return;
    apiGet("/workspace/status").then(function (data) {
      if (data && typeof data.workspaceDir === "string") {
        el.textContent = data.workspaceDir + (data.isDefault ? "  (default)" : "");
        el.title = data.workspaceDir;
      }
    }).catch(function () { /* leave placeholder */ });
  }

  function openWorkspacePromptModal(currentPath) {
    var modal = $("#workspace-prompt-modal");
    var pathEl = $("#workspace-prompt-path");
    var input = $("#workspace-prompt-input");
    if (!modal || !pathEl || !input) return;
    pathEl.textContent = currentPath || "(unknown)";
    input.value = currentPath || "";
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeWorkspacePromptModal() {
    var modal = $("#workspace-prompt-modal");
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  }

  function promptWorkspaceIfDefault() {
    if (localStorage.getItem(WORKSPACE_PROMPT_DISMISSED_KEY) === "1") {
      return;
    }
    apiGet("/workspace/status").then(function (data) {
      if (!data || data.isDefault !== true) {
        return;
      }
      openWorkspacePromptModal(data.workspaceDir);
    }).catch(function () {
      // status endpoint unavailable - skip the prompt silently
    });
  }

  function bindWorkspacePrompt() {
    var modal = $("#workspace-prompt-modal");
    if (!modal || modal.dataset.bound === "true") return;
    modal.dataset.bound = "true";

    modal.addEventListener("click", function (event) {
      if (event.target && event.target.hasAttribute && event.target.hasAttribute("data-workspace-prompt-close")) {
        localStorage.setItem(WORKSPACE_PROMPT_DISMISSED_KEY, "1");
        closeWorkspacePromptModal();
      }
    });

    var browse = $("#workspace-prompt-browse");
    var input = $("#workspace-prompt-input");
    var apply = $("#workspace-prompt-apply");

    if (browse) {
      browse.addEventListener("click", function () {
        if (typeof window.showDirectoryPicker === "function") {
          window.showDirectoryPicker({ mode: "readwrite", id: "teamclaw-workspace" })
            .then(function (handle) {
              if (input) {
                input.value = handle.name || input.value;
                input.dataset.verifiedPath = "";
              }
              showError("Browser directory picker cannot return full server paths; please type the absolute path instead.");
            })
            .catch(function () {
              /* user cancelled */
            });
        } else {
          showError("This browser does not support a native directory picker; please type the absolute path instead.");
        }
      });
    }

    if (apply) {
      apply.addEventListener("click", function () {
        var value = input && typeof input.value === "string" ? input.value.trim() : "";
        if (!value || value.indexOf("/") !== 0) {
          showError("Please enter an absolute path starting with /");
          return;
        }
        apply.disabled = true;
        apiPost("/workspace/change-dir", { workspaceDir: value }).then(function () {
          localStorage.setItem(WORKSPACE_PROMPT_DISMISSED_KEY, "1");
          closeWorkspacePromptModal();
          showError("Workspace updated to " + value + ". Restart the gateway (openclaw gateway restart) to apply it.");
          updateWorkspacePathIndicator();
        }).catch(function (err) {
          showError(err instanceof Error ? err.message : "Failed to update workspace directory");
        }).finally(function () {
          apply.disabled = false;
        });
      });
    }
  }

  applyStaticTranslations();
  renderWorkspaceTree(workspaceTree);
  renderWorkspaceFile();
  refreshAll().then(applyInitialUiState).catch(function () {});
  connectWebSocket();
  bindWorkspacePrompt();
  promptWorkspaceIfDefault();
  updateWorkspacePathIndicator();
  bindModelSettings();
  bindGithubCorner();

  function bindModelSettings() {
  /* Module-level IIFE helper: delegated here to keep startup order simple. */
  var opener = document.createElement("button");
  opener.className = "btn btn-small";
  opener.type = "button";
  opener.id = "model-settings-open";
  opener.textContent = "Models";
  var refreshBtn = document.querySelector("#workspace-tree-refresh");
  if (refreshBtn && refreshBtn.parentElement) {
    refreshBtn.parentElement.appendChild(opener);
    opener.addEventListener("click", openModelSettings);
  }

  var modal = document.querySelector("#model-settings-modal");
  if (!modal || modal.dataset.bound === "true") return;
  modal.dataset.bound = "true";

  modal.addEventListener("click", function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute("data-model-settings-close")) {
      closeModelSettings();
    }
  });

  var save = document.querySelector("#model-settings-save");
  if (save) {
    save.addEventListener("click", function () {
      var defaultSelect = document.querySelector("#model-settings-default");
      var payload = { roleModelOverrides: {} };
      if (defaultSelect && defaultSelect.value) {
        payload.defaultModel = defaultSelect.value;
      }
      modal.querySelectorAll("[data-role-model]").forEach(function (sel) {
        var role = sel.getAttribute("data-role-model");
        if (role && sel.value) {
          payload.roleModelOverrides[role] = sel.value;
        }
      });
      save.disabled = true;
      apiRequest("/models/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function () {
        showError("Model settings saved. Hot-reload applies; restart the gateway if needed.");
        closeModelSettings();
      }).catch(function (err) {
        showError(err instanceof Error ? err.message : "Failed to save model settings");
      }).finally(function () {
        save.disabled = false;
      });
    });
  }
}

function bindGithubCorner() {
  var cornerLogin = document.querySelector("#github-corner-login");
  if (cornerLogin && !cornerLogin.dataset.bound) {
    cornerLogin.dataset.bound = "true";
    cornerLogin.addEventListener("click", function () {
      window.open("/ui/auth/github", "_blank", "noopener");
      pollGithubAuthStatus(360);
    });
  }
  var cornerUser = document.querySelector("#github-corner-user");
  if (cornerUser && !cornerUser.dataset.bound) {
    cornerUser.dataset.bound = "true";
    cornerUser.addEventListener("click", function () {
      apiRequest("/auth/github/logout", { method: "POST" }).catch(function () { /* refresh below regardless */ }).finally(function () {
        refreshGithubAuthStatus();
      });
    });
    cornerUser.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        cornerUser.click();
      }
    });
  }
  // Keep the header-corner login state fresh.
  setInterval(refreshGithubAuthStatus, 10000);
  refreshGithubAuthStatus();
}

var githubAuthPollTimer = null;
function pollGithubAuthStatus(attemptsLeft) {
  if (githubAuthPollTimer) clearTimeout(githubAuthPollTimer);
  if (attemptsLeft <= 0) return;
  githubAuthPollTimer = setTimeout(function () {
    apiGet("/auth/github/status").then(function (status) {
      if (status && status.authenticated) {
        renderGithubCorner(status);
      } else {
        pollGithubAuthStatus(attemptsLeft - 1);
      }
    }).catch(function () {
      pollGithubAuthStatus(attemptsLeft - 1);
    });
  }, 2500);
}

function renderGithubCorner(status) {
  var loginBtn = document.querySelector("#github-corner-login");
  var userChip = document.querySelector("#github-corner-user");
  if (!loginBtn || !userChip) return;
  if (status.authenticated && status.account) {
    var nameEl = document.querySelector("#github-corner-name");
    if (nameEl) nameEl.textContent = "@" + status.account.login;
    var av = document.querySelector("#github-corner-avatar");
    if (av) {
      if (status.account.avatarUrl) {
        av.src = status.account.avatarUrl;
        av.classList.remove("hidden");
      } else {
        av.classList.add("hidden");
      }
    }
    userChip.classList.remove("hidden");
    loginBtn.hidden = true;
  } else {
    userChip.classList.add("hidden");
    loginBtn.textContent = t("gh.login");
    loginBtn.hidden = false;
  }
}

function refreshGithubAuthStatus() {
  apiGet("/auth/github/status").then(renderGithubCorner).catch(function () {
    /* controller offline - keep the corner as-is */
  });
}

function openModelSettings() {
  var modal = document.querySelector("#model-settings-modal");
  if (!modal) return;
  apiGet("/models/config").then(function (catalog) {
    var options = [];
    (catalog.providers || []).forEach(function (provider) {
      (provider.models || []).forEach(function (modelId) {
        options.push({ value: provider.id + "/" + modelId, label: provider.id + " / " + modelId });
      });
      if (!provider.models || provider.models.length === 0) {
        options.push({ value: provider.id, label: provider.id + " (provider default)" });
      }
    });
    if (catalog.defaultModel && !options.some(function (opt) { return opt.value === catalog.defaultModel; })) {
      options.unshift({ value: catalog.defaultModel, label: catalog.defaultModel + " (current)" });
    }

    var defaultSelect = document.querySelector("#model-settings-default");
    if (defaultSelect) {
      defaultSelect.innerHTML = options.map(function (opt) {
        return '<option value="' + escapeHtml(opt.value) + '">' + escapeHtml(opt.label) + "</option>";
      }).join("");
      defaultSelect.value = catalog.defaultModel || (options.length ? options[0].value : "");
    }

    var rolesEl = document.querySelector("#model-settings-roles");
    if (rolesEl) {
      rolesEl.innerHTML = (catalog.roles || []).map(function (role) {
        var current = (catalog.roleModelOverrides || {})[role.id] || "";
        return (
          '<label class="model-settings-field">' +
          '  <span class="model-settings-label">' + escapeHtml(role.label) + '</span>' +
          '  <select data-role-model="' + escapeHtml(role.id) + '">' +
          '    <option value="">(use default)</option>' +
          options.map(function (opt) {
            return '<option value="' + escapeHtml(opt.value) + '"' + (current === opt.value ? " selected" : "") + '>' + escapeHtml(opt.label) + "</option>";
          }).join("") +
          "  </select>" +
          "</label>"
        );
      }).join("");
    }

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }).catch(function (err) {
    showError(err instanceof Error ? err.message : "Failed to load model catalog");
  });
}

function closeModelSettings() {
  var modal = document.querySelector("#model-settings-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}
  // ==================== TeamAuto tab ====================

  var teamAutoCandidates = [];
  var teamAutoCandidatesLoaded = false;

  function teamAutoSetMsg(text, ok) {
    var el = $("#teamauto-bind-msg");
    if (!el) { return; }
    el.textContent = text || "";
    el.className = "teamauto-msg" + (text ? (ok ? " ok" : " err") : "");
  }

  function loadTeamAutoCandidates(force) {
    if (teamAutoCandidatesLoaded && !force) { return Promise.resolve(); }
    var select = $("#teamauto-repo-select");
    if (select) { select.innerHTML = '<option>' + escapeHtml(t("teamauto.loadingRepos")) + "</option>"; }
    return apiGet("/teamauto/repo-candidates").then(function (data) {
      teamAutoCandidates = (data && data.candidates) || [];
      teamAutoCandidatesLoaded = true;
      if (!select) { return; }
      if (!teamAutoCandidates.length) {
        select.innerHTML = '<option value="">' + escapeHtml(t("teamauto.noCandidates")) + "</option>";
        return;
      }
      select.innerHTML = teamAutoCandidates.map(function (r) {
        return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.id + (r.private ? " (private)" : "")) + "</option>";
      }).join("");
    }).catch(function (err) {
      if (select) { select.innerHTML = '<option value="">' + escapeHtml(t("teamauto.loginFirst")) + "</option>"; }
      teamAutoSetMsg(err instanceof Error ? err.message : String(err), false);
    });
  }

  function renderTeamAutoRepos(status) {
    var wrap = $("#teamauto-repos");
    if (!wrap) { return; }
    var repos = (status && status.repos) || [];
    if (!repos.length) {
      wrap.innerHTML = '<div class="empty-state">' + escapeHtml(t("teamauto.empty")) + "</div>";
      return;
    }
    wrap.innerHTML = repos.map(function (r) {
      var badge = !r.enabled
        ? '<span class="teamauto-badge">' + escapeHtml(t("teamauto.disabled")) + "</span>"
        : r.provision && r.provision.status === "provisioning"
          ? '<span class="teamauto-badge" title="' + escapeHtml(r.provision.message || "") + '">' + escapeHtml(t("teamauto.provisioning")) + "</span>"
          : r.provision && r.provision.status === "failed"
            ? '<span class="teamauto-badge warn" title="' + escapeHtml(r.provision.message || "") + '">' + escapeHtml(t("teamauto.provisionFailed")) + "</span>"
            : r.pausedReason
              ? '<span class="teamauto-badge warn" title="' + escapeHtml(r.pausedReason) + '">' + escapeHtml(t("teamauto.paused")) + "</span>"
              : '<span class="teamauto-badge on">' + escapeHtml(t("teamauto.active")) + "</span>";
      var when = r.lastSweepAt ? new Date(r.lastSweepAt).toLocaleString() : "-";
      var norms = r.norms ? escapeHtml(r.norms.commitStyle) : "...";
      var fr = r.policy.actions.fullReview;
      return '<div class="teamauto-card card" data-repo="' + escapeHtml(r.id) + '">' +
        '<div class="teamauto-card-head"><span class="teamauto-repo-name">' + escapeHtml(r.id) + "</span>" + badge + "</div>" +
        '<div class="teamauto-meta">' +
        escapeHtml(t("teamauto.schedule")) + ": <code>" + escapeHtml(r.schedule) + "</code> | " +
        escapeHtml(t("teamauto.lastSweep")) + ": " + escapeHtml(when) +
        (r.lastSweepSummary ? " | " + escapeHtml(r.lastSweepSummary) : "") +
        "<br>" + escapeHtml(t("teamauto.norms")) + ": " + norms +
        (r.pausedReason ? '<br><span class="teamauto-warn-text">' + escapeHtml(r.pausedReason) + "</span>" : "") +
        "</div>" +
        '<div class="teamauto-config-row">' +
        '<label>' + escapeHtml(t("teamauto.schedule")) + ' <input data-cfg="schedule" type="text" value="' + escapeHtml(r.schedule) + '" spellcheck="false"></label>' +
        '<label>' + escapeHtml(t("teamauto.maxPerSweep")) + ' <input data-cfg="maxTasksPerSweep" type="number" min="1" max="20" value="' + r.policy.maxTasksPerSweep + '"></label>' +
        '<label>' + escapeHtml(t("teamauto.fullReview")) + ' <select data-cfg="fullReview">' +
        ["off", "weekly", "daily"].map(function (v) { return '<option value="' + v + '"' + (fr === v ? " selected" : "") + ">" + v + "</option>"; }).join("") +
        "</select></label>" +
        '<label>' + escapeHtml(t("teamauto.takeOwnership")) + ' <select data-cfg="takeOwnership">' +
        '<option value="true"' + (r.policy.actions.takeOwnership ? " selected" : "") + ">on</option>" +
        '<option value="false"' + (!r.policy.actions.takeOwnership ? " selected" : "") + ">off</option>" +
        "</select></label>" +
        '<button class="btn btn-small" data-act="save">' + escapeHtml(t("teamauto.save")) + "</button>" +
        "</div>" +
        '<div class="teamauto-actions">' +
        '<button class="btn btn-small" data-act="sweep">' + escapeHtml(t("teamauto.sweep")) + "</button>" +
        '<button class="btn btn-small" data-act="toggle">' + escapeHtml(t(r.enabled ? "teamauto.disable" : "teamauto.enable")) + "</button>" +
        '<button class="btn btn-small btn-danger" data-act="unbind">' + escapeHtml(t("teamauto.unbind")) + "</button>" +
        "</div></div>";
    }).join("");
  }

  var teamAutoBusy = false;
  function renderTeamAutoActivity(activity) {
    var wrap = $("#teamauto-activity");
    if (!wrap) { return; }
    var list = activity || [];
    if (!list.length) {
      wrap.innerHTML = '<div class="empty-state">' + escapeHtml(t("teamauto.activityEmpty")) + "</div>";
      return;
    }
    wrap.innerHTML = list.slice(0, 30).map(function (e) {
      var when = new Date(e.at || 0).toLocaleString();
      return '<div class="teamauto-activity-item">'
        + '<span class="teamauto-activity-kind k-' + escapeHtml(String(e.kind || "sweep")) + '">' + escapeHtml(String(e.kind || "")) + "</span>"
        + '<span class="teamauto-activity-text"><b>' + escapeHtml(String(e.repoId || "")) + "</b> " + escapeHtml(String(e.text || "")) + "</span>"
        + '<span class="teamauto-activity-time">' + escapeHtml(when) + "</span>"
        + "</div>";
    }).join("");
  }

  function refreshTeamAutoTab() {
    if (teamAutoBusy) { return; }
    teamAutoBusy = true;
    void loadTeamAutoCandidates(false);
    apiGet("/teamauto/repos").then(renderTeamAutoRepos).catch(function () {
      /* scheduler not running yet */
    }).finally(function () { teamAutoBusy = false; });
    apiGet("/teamauto/activity").then(function (data) {
      renderTeamAutoActivity((data && data.activity) || []);
    }).catch(function () { /* activity is best-effort */ });
  }

  function bindTeamAutoTabEvents() {
    var bindBtn = $("#teamauto-bind");
    if (bindBtn && !bindBtn.dataset.bound) {
      bindBtn.dataset.bound = "true";
      bindBtn.addEventListener("click", function () {
        var select = $("#teamauto-repo-select");
        var repo = select ? select.value.trim() : "";
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          teamAutoSetMsg(t("teamauto.needRepo"), false);
          return;
        }
        var sched = $("#teamauto-schedule");
        bindBtn.disabled = true;
        teamAutoSetMsg("...");
        teamAutoBindWithOverlay(repo, sched && sched.value.trim() ? sched.value.trim() : undefined)
          .then(function (ok) {
            if (ok) { teamAutoSetMsg(repo + " -> " + t("teamauto.active"), true); refreshTeamAutoTab(); }
          })
          .finally(function () { bindBtn.disabled = false; });
      });
    }

    function teamAutoSetBindStage(stage, note, isError) {
      var overlay = $("#teamauto-bind-overlay");
      if (!overlay) { return; }
      overlay.querySelectorAll(".ta-bind-steps li").forEach(function (li) {
        var n = parseInt(li.getAttribute("data-stage") || "0", 10);
        li.classList.toggle("done", !isError && n < stage);
        li.classList.toggle("active", !isError && n === stage);
        li.classList.toggle("error", !!isError && n === stage);
      });
      var noteEl = $("#teamauto-bind-note");
      if (noteEl) { noteEl.textContent = note || ""; noteEl.className = "ta-bind-note" + (isError ? " err" : ""); }
    }

    function teamAutoBindWithOverlay(repo, schedule) {
      var overlay = $("#teamauto-bind-overlay");
      var closeBtn = $("#teamauto-bind-overlay-close");
      var titleEl = $("#teamauto-bind-title");
      if (!overlay) {
        return apiRequest("/teamauto/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repo, schedule: schedule }) })
          .then(function () { return true; })
          .catch(function (err) { teamAutoSetMsg(err instanceof Error ? err.message : String(err), false); return false; });
      }
      if (titleEl) { titleEl.textContent = t("teamauto.bind") + ": " + repo; }
      if (closeBtn) {
        closeBtn.classList.add("is-hidden");
        closeBtn.addEventListener("click", function () { overlay.classList.add("is-hidden"); }, { once: true });
      }
      overlay.classList.remove("is-hidden");
      teamAutoSetBindStage(1, "");
      return apiRequest("/teamauto/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: repo, schedule: schedule }) })
        .catch(function (err) {
          teamAutoSetBindStage(1, err instanceof Error ? err.message : String(err), true);
          if (closeBtn) { closeBtn.classList.remove("is-hidden"); }
          return null;
        })
        .then(function (created) {
          if (created === null) { return false; }
          // Poll the background provision (clone + norms) until it settles.
          var deadline = Date.now() + 300000;
          var lastStage = 1;
          function poll() {
            if (Date.now() > deadline) {
              teamAutoSetBindStage(lastStage, "timeout", true);
              if (closeBtn) { closeBtn.classList.remove("is-hidden"); }
              return Promise.resolve(false);
            }
            return apiRequest("/teamauto/repos", { method: "GET" }).then(function (data) {
              var list = (data && data.repos) || [];
              var hit = null;
              for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === repo) { hit = list[i]; break; } }
              var provision = (hit && hit.provision) || (hit ? { status: "ready" } : null);
              if (!provision) { return new Promise(function (r) { setTimeout(r, 1500); }).then(poll); }
              if (provision.status === "failed") {
                teamAutoSetBindStage(lastStage, t("teamauto.bindFailed") + ": " + (provision.message || ""), true);
                if (closeBtn) { closeBtn.classList.remove("is-hidden"); }
                return false;
              }
              var stage = /norm/i.test(provision.message || "") ? 3 : 2;
              lastStage = Math.max(lastStage, stage);
              teamAutoSetBindStage(stage, provision.message || "");
              if (provision.status === "ready") {
                teamAutoSetBindStage(4, t("teamauto.bindReady"));
                setTimeout(function () { overlay.classList.add("is-hidden"); }, 900);
                return true;
              }
              return new Promise(function (r) { setTimeout(r, 1500); }).then(poll);
            }).catch(function () { return new Promise(function (r) { setTimeout(r, 1500); }).then(poll); });
          }
          return poll();
        });
    }
    var refreshBtn = $("#teamauto-repos-refresh");
    if (refreshBtn && !refreshBtn.dataset.bound) {
      refreshBtn.dataset.bound = "true";
      refreshBtn.addEventListener("click", function () {
        refreshBtn.disabled = true;
        void loadTeamAutoCandidates(true).finally(function () { refreshBtn.disabled = false; });
      });
    }
    var wrap = $("#teamauto-repos");
    if (wrap && !wrap.dataset.bound) {
      wrap.dataset.bound = "true";
      wrap.addEventListener("click", function (event) {
        var btn = event.target;
        if (!(btn instanceof Element) || btn.tagName !== "BUTTON") { return; }
        var card = btn.closest("[data-repo]");
        if (!card) { return; }
        var repoId = card.getAttribute("data-repo");
        var act = btn.getAttribute("data-act");
        var encoded = encodeURIComponent(repoId);
        btn.disabled = true;
        var call;
        if (act === "sweep") {
          call = apiRequest("/teamauto/repos/" + encoded + "/sweep", { method: "POST" })
            .then(function (body) { teamAutoSetMsg(body && body.summary ? body.summary : "sweep done", true); });
        } else if (act === "unbind") {
          if (!window.confirm(t("teamauto.confirmUnbind"))) { btn.disabled = false; return; }
          call = apiRequest("/teamauto/repos/" + encoded, { method: "DELETE" });
        } else if (act === "toggle") {
          var enabling = btn.textContent.trim() !== t("teamauto.disable");
          call = apiRequest("/teamauto/repos/" + encoded, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: enabling }),
          });
        } else if (act === "save") {
          var payload = {};
          card.querySelectorAll("[data-cfg]").forEach(function (el) {
            var key = el.getAttribute("data-cfg");
            if (key === "schedule") { payload.schedule = el.value.trim(); }
            if (key === "maxTasksPerSweep") { payload.maxTasksPerSweep = Number(el.value) || undefined; }
            if (key === "fullReview") { payload.fullReview = el.value; }
            if (key === "takeOwnership") { payload.takeOwnership = el.value === "true"; }
          });
          call = apiRequest("/teamauto/repos/" + encoded, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).then(function () { teamAutoSetMsg(t("teamauto.saved"), true); });
        }
        if (call) {
          call.catch(function (err) { teamAutoSetMsg(err instanceof Error ? err.message : String(err), false); })
            .finally(function () { refreshTeamAutoTab(); });
        } else {
          btn.disabled = false;
        }
      });
    }
  }

  bindTeamAutoTabEvents();
  setInterval(function () {
    if (activeTab === "teamauto") { refreshTeamAutoTab(); }
  }, 10000);

})();

  // Tunnel sharing (internet gate for the local web UI).
  function initTunnelPanel() {
    const wrap = document.getElementById("tunnel-panel");
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = "true";
    const render = (st) => {
      wrap.querySelector(".tunnel-state").innerHTML = st.active
        ? '<div class="tunnel-on">Live: <a href="https://' + st.hostname + '" target="_blank" rel="noopener">https://' + st.hostname + '</a></div>'
          + '<div class="tunnel-token">Gate token: <b>' + st.gateToken + '</b></div>'
          + '<button class="btn btn-small" data-act="stop">Stop sharing</button>'
        : '<button class="btn btn-small btn-primary" data-act="start">Share via tunnel</button>'
          + '<span class="tunnel-note">requires GitHub login</span>';
    };
    const refresh = () => apiGet("/tunnel/status").then((st) => render(st || {})).catch(() => {});
    wrap.addEventListener("click", (e) => {
      const act = e.target.getAttribute && e.target.getAttribute("data-act");
      if (!act) return;
      e.target.disabled = true;
      const call = act === "start" ? apiRequest("/tunnel/start", { method: "POST" }) : apiRequest("/tunnel/stop", { method: "POST" });
      call.then(refresh).catch((err) => { wrap.querySelector(".tunnel-state").innerHTML = '<div class="tunnel-err">' + escapeHtml(String(err.message || err)) + "</div>"; });
    });
    refresh();
    setInterval(refresh, 5000);
  }
  document.addEventListener("DOMContentLoaded", initTunnelPanel);
