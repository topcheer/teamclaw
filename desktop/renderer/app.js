(function () {
  "use strict";

  const desktop = window.teamclawDesktop;
  const STORAGE_KEY = "teamclaw-desktop-conversation";
  const SESSION_KEY = "teamclaw-desktop-session";
  const LANGUAGE_KEY = "teamclaw-desktop-language";

  const state = {
    settings: null,
    controllerUrl: "",
    ws: null,
    currentView: "mission",
    taskFilter: "all",
    noticeFilter: "all",
    connectionState: "disconnected",
    connectionExpanded: true,
    noticeDrawerOpen: false,
    conversation: loadConversation(),
    sessionKey: loadSessionKey(),
    teamStatus: {
      tasks: [],
      workers: [],
      clarifications: [],
      controllerRuns: [],
      messages: [],
      modelReadiness: null,
      externalWorkerInstall: null,
    },
    reports: [],
    notifications: [],
    localSetupInfo: null,
    localSetupMode: "controller-process",
    unavailableScreenVisible: false,
    unavailableReason: "",
    isInstallingLocal: false,
    isInstallingOpenClaw: false,
    selectedTaskId: "",
    selectedTaskDetailTab: "overview",
    taskTimelineAutoFollow: true,
    taskDetailData: null,
    selectedPlanningRunId: "",
    planningGroupCollapsed: { completed: true },
    selectedWorkspacePath: "",
    selectedWorkspaceFile: null,
    workspaceView: "source",
    workspaceTree: [],
    isConnecting: false,
    isRefreshing: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    pendingRefreshTimer: null,
    clarificationPromptOpen: false,
    activeClarificationId: "",
    dismissedClarificationIds: [],
    externalWorkerRole: 'developer',
    externalWorkerDiscoveryMode: 'mdns',
    externalWorkerInstallVisible: false,
    language: loadLanguage(),
  };

  const TRANSLATIONS = {
    en: {
      "connection.notConnected": "Not connected",
      "connection.disconnected": "Disconnected",
      "connection.connecting": "Connecting",
      "connection.reconnecting": "Reconnecting",
      "connection.connected": "Connected",
      "connection.waiting": "Waiting for a controller connection…",
      "connection.noSummary": "No controller summary yet.",
      "connection.connectedTo": "Connected to {url}",
      "connection.retrying": "Controller unavailable. Retrying in {seconds}s…",
      "connection.controller": "Controller",
      "connection.edit": "Edit",
      "connection.done": "Done",
      "connection.connect": "Connect",
      "connection.refresh": "Refresh",
      "mission.title": "Mission",
      "tab.planning": "Planning",
      "tab.tasks": "Tasks",
      "tab.clarifications": "Clarifications",
      "tab.workspace": "Workspace",
      "tab.reports": "Reports",
      "mission.newRequirement": "New requirement",
      "mission.notifications": "Notifications",
      "mission.requirement": "Requirement",
      "mission.summary": "Summary",
      "mission.recentInteraction": "Recent interaction",
      "mission.connectHint": "Connect to a controller to load team state.",
      "mission.noConversation": "No conversation yet.",
      "planning.runs": "Planning runs",
      "planning.empty": "Select a planning run to inspect the kickoff discussion.",
      "planning.requirement": "Requirement",
      "planning.originalRequest": "Original request",
      "planning.requiredRoles": "Required roles",
      "planning.candidateRoles": "Kickoff roles",
      "planning.complexity": "Complexity",
      "planning.createdTasks": "Created tasks",
      "planning.deferredTasks": "Deferred tasks",
      "planning.clarificationsNeeded": "Clarifications needed",
      "planning.handoffPlan": "Handoff plan",
      "planning.notes": "Notes",
      "planning.assessments": "Kickoff assessments",
      "planning.scope": "Scope",
      "planning.suggestedTasks": "Suggested tasks",
      "planning.dependencies": "Dependencies",
      "planning.risks": "Risks",
      "planning.questions": "Open questions",
      "planning.noControllerOutput": "No controller output yet.",
      "planning.groupActive": "Active",
      "planning.groupPending": "Pending",
      "planning.groupCompleted": "Completed",
      "planning.groupBlockedFailed": "Blocked / Failed",
      "summary.workers": "Workers",
      "summary.pending": "Pending",
      "summary.blocked": "Blocked",
      "summary.completed": "Completed",
      "task.title": "Task",
      "task.auto": "Auto",
      "task.details": "Task details",
      "task.timeline": "Timeline",
      "task.messages": "Messages",
      "task.loadingDetail": "Loading task detail…",
      "task.failedLoadDetail": "Failed to load task detail",
      "clarification.answerPlaceholder": "Answer",
      "clarification.question": "Question",
      "clarification.whyBlocked": "Why blocked",
      "clarification.context": "Context",
      "clarification.answer": "Answer",
      "clarification.needed": "Clarification needed",
      "clarification.project": "Project clarification",
      "clarification.task": "Task clarification",
      "clarification.queue.one": "1 pending clarification",
      "clarification.queue.many": "{count} pending clarifications",
      "clarification.humanInput": "Human input required",
      "clarification.openTask": "Open task context",
      "clarification.openPlanning": "Open planning context",
      "clarification.later": "Later",
      "clarification.historyEmpty": "No clarification history.",
      "task.groupProject": "Project",
      "task.selectHint": "Select a task to inspect its timeline and execution.",
      "workspace.selectFile": "Select a file",
      "workspace.selectedFile": "Selected file",
      "workspace.selectHint": "Select a workspace file to inspect it.",
      "planning.runFallback": "Planning run",
      "reports.projectFallback": "Project",
      "reports.deliveryTitle": "{project} delivery report",
      "task.filter.none": "No tasks in this filter.",
      "clarifications.none": "No clarifications right now.",
      "workspace.none": "No workspace entries yet.",
      "reports.none": "No delivery reports yet.",
      "runtime.title": "TeamClaw is installed but cannot work yet.",
      "runtime.noModel": "No TeamClaw model is configured for this instance.",
      "runtime.noAuth": "No usable OpenClaw auth profile was found for TeamClaw.",
      "bootstrap.title": "TeamClaw is unavailable on this machine.",
      "bootstrap.subtitle": "We'll first try to connect to the local controller. If it isn't running yet, you can install TeamClaw here, start it, or point this app at another controller.",
      "bootstrap.status": "Startup status",
      "bootstrap.autoStarting": "Trying to start the local controller…",
      "bootstrap.connecting": "Connecting to the local controller…",
      "bootstrap.failed": "Couldn't reach the local TeamClaw controller.",
      "bootstrap.mode": "Install mode",
      "bootstrap.manualMode": "Local quickstart",
      "bootstrap.manualModeHint": "Runs the controller here and launches local worker processes on demand with controller-decided defaults.",
      "bootstrap.processMode": "Local multi-process",
      "bootstrap.processModeHint": "Runs the controller here and provisions local worker processes on demand. Uses more CPU and memory.",
      "bootstrap.command": "One-line install command",
      "bootstrap.copyInstall": "Copy install command",
      "bootstrap.installNow": "Install now",
      "bootstrap.installing": "Installing…",
      "bootstrap.openclawMissingTitle": "OpenClaw is not installed on this machine yet.",
      "bootstrap.openclawMissingSubtitle": "Install OpenClaw first, then come back here to install TeamClaw.",
      "bootstrap.openclawInstallLabel": "OpenClaw one-click install command",
      "bootstrap.openclawQuickstartLabel": "OpenClaw guided quickstart command",
      "bootstrap.openclawInstallNow": "Install OpenClaw now",
      "bootstrap.teamclawInstallLabel": "TeamClaw one-line install command",
      "bootstrap.teamclawDetectedTitle": "OpenClaw is installed, but the local TeamClaw controller is unavailable.",
      "bootstrap.teamclawDetectedSubtitle": "Install TeamClaw into your local OpenClaw setup, or point this app at another controller.",
      "bootstrap.startLocal": "Start local controller",
      "bootstrap.startingLocal": "Starting…",
      "bootstrap.remoteTitle": "Or connect to another controller",
      "bootstrap.remoteHint": "You can still point this desktop app at a remote TeamClaw controller.",
      "bootstrap.remoteUrl": "Controller URL",
      "bootstrap.connectRemote": "Connect to this controller",
      "bootstrap.copied": "Copied",
      "bootstrap.modeWarning": "This mode uses more resources on the current machine, but gives local workers stronger process isolation.",
      "bootstrap.manualWarning": "This mode still executes work locally. TeamClaw provisions local worker processes on demand, but keeps the default worker pool leaner.",
      "bootstrap.logs": "Local controller activity",
      "bootstrap.startCommand": "OpenClaw guided quickstart command",
      "bootstrap.componentsLabel": "Component install command",
      "worker.add": "Add worker",
      "worker.hide": "Hide worker command",
      "worker.cardTitle": "Register a new external worker",
      "worker.cardSubtitle": "Generate a one-line worker installer command for another machine.",
      "worker.role": "Role",
      "worker.discovery": "Controller discovery",
      "worker.discoveryMdns": "LAN auto-discovery (mDNS)",
      "worker.discoveryManual": "Manual controller URL (LAN IP)",
      "worker.copy": "Copy command",
      "worker.copied": "Copied",
      "worker.recommendedUrl": "Recommended controller URL: ",
      "planning.none": "No projects yet.",
      "planning.consensus": "Consensus",
      "planning.controllerOutput": "Controller output",
      "planning.noOutput": "No controller output yet.",
      "action.languageToggleZh": "中文",
      "action.languageToggleEn": "English"
    },
    zh: {
      "connection.notConnected": "未连接",
      "connection.disconnected": "已断开",
      "connection.connecting": "连接中",
      "connection.reconnecting": "重连中",
      "connection.connected": "已连接",
      "connection.waiting": "等待连接 controller…",
      "connection.noSummary": "暂无 controller 摘要。",
      "connection.connectedTo": "已连接到 {url}",
      "connection.retrying": "Controller 不可用，{seconds} 秒后重试…",
      "connection.controller": "Controller",
      "connection.edit": "编辑",
      "connection.done": "完成",
      "connection.connect": "连接",
      "connection.refresh": "刷新",
      "mission.title": "任务台",
      "tab.planning": "规划",
      "tab.tasks": "任务",
      "tab.clarifications": "澄清",
      "tab.workspace": "工作区",
      "tab.reports": "报告",
      "mission.newRequirement": "新需求",
      "mission.notifications": "通知",
      "mission.requirement": "需求",
      "mission.summary": "摘要",
      "mission.recentInteraction": "最近交互",
      "mission.connectHint": "连接到 controller 后即可加载团队状态。",
      "mission.noConversation": "暂无对话。",
      "planning.runs": "规划运行",
      "planning.empty": "选择一个规划运行以查看 kickoff 讨论。",
      "planning.requirement": "需求",
      "planning.originalRequest": "原始需求",
      "planning.requiredRoles": "所需角色",
      "planning.candidateRoles": "Kickoff 参与角色",
      "planning.complexity": "复杂度",
      "planning.createdTasks": "已创建任务",
      "planning.deferredTasks": "延后任务",
      "planning.clarificationsNeeded": "待澄清问题",
      "planning.handoffPlan": "交接计划",
      "planning.notes": "备注",
      "planning.assessments": "Kickoff 评估",
      "planning.scope": "范围判断",
      "planning.suggestedTasks": "建议任务",
      "planning.dependencies": "依赖项",
      "planning.risks": "风险",
      "planning.questions": "开放问题",
      "planning.noControllerOutput": "暂无 controller 输出。",
      "planning.groupActive": "进行中",
      "planning.groupPending": "待开始",
      "planning.groupCompleted": "已完成",
      "planning.groupBlockedFailed": "阻塞 / 失败",
      "summary.workers": "Workers",
      "summary.pending": "待处理",
      "summary.blocked": "阻塞",
      "summary.completed": "完成",
      "task.title": "任务",
      "task.auto": "自动分配",
      "task.details": "任务详情",
      "task.timeline": "时间线",
      "task.messages": "消息",
      "task.loadingDetail": "正在加载任务详情…",
      "task.failedLoadDetail": "加载任务详情失败",
      "clarification.answerPlaceholder": "回答",
      "clarification.question": "问题",
      "clarification.whyBlocked": "阻塞原因",
      "clarification.context": "上下文",
      "clarification.answer": "回答",
      "clarification.needed": "需要人工澄清",
      "clarification.project": "项目澄清",
      "clarification.task": "任务澄清",
      "clarification.queue.one": "1 条待处理澄清",
      "clarification.queue.many": "{count} 条待处理澄清",
      "clarification.humanInput": "需要人工输入",
      "clarification.openTask": "打开任务上下文",
      "clarification.openPlanning": "打开规划上下文",
      "clarification.later": "稍后处理",
      "clarification.historyEmpty": "暂无澄清历史。",
      "task.groupProject": "项目",
      "task.selectHint": "选择一个任务以查看它的时间线和执行详情。",
      "workspace.selectFile": "选择文件",
      "workspace.selectedFile": "已选文件",
      "workspace.selectHint": "选择一个工作区文件以查看内容。",
      "planning.runFallback": "规划运行",
      "reports.projectFallback": "项目",
      "reports.deliveryTitle": "{project} 交付报告",
      "task.filter.none": "当前筛选下暂无任务。",
      "clarifications.none": "当前暂无澄清。",
      "workspace.none": "暂无工作区内容。",
      "reports.none": "暂无交付报告。",
      "runtime.title": "TeamClaw 已安装，但当前还无法工作。",
      "runtime.noModel": "当前实例还没有为 TeamClaw 配置模型。",
      "runtime.noAuth": "未找到 TeamClaw 可用的 OpenClaw 认证配置。",
      "bootstrap.title": "当前这台机器上的 TeamClaw 不可用。",
      "bootstrap.subtitle": "应用会先尝试连接本机 controller；如果本机还没跑起来，你可以在这里安装、启动，或改连到别的 controller。",
      "bootstrap.status": "启动状态",
      "bootstrap.autoStarting": "正在尝试启动本地 controller…",
      "bootstrap.connecting": "正在连接本地 controller…",
      "bootstrap.failed": "暂时无法连上本机 TeamClaw controller。",
      "bootstrap.mode": "安装模式",
      "bootstrap.manualMode": "本机快速开始",
      "bootstrap.manualModeHint": "controller 在本机运行，并按需拉起本地 worker 进程；使用 controller 决定的默认配置，安装最省事。",
      "bootstrap.processMode": "本机多进程",
      "bootstrap.processModeHint": "controller 在本机运行，并按需拉起本地 worker 进程。隔离性更强，但会消耗更多 CPU / 内存。",
      "bootstrap.command": "一行安装命令",
      "bootstrap.copyInstall": "复制安装命令",
      "bootstrap.installNow": "立即安装",
      "bootstrap.installing": "安装中…",
      "bootstrap.openclawMissingTitle": "这台机器上还没有安装 OpenClaw。",
      "bootstrap.openclawMissingSubtitle": "请先安装 OpenClaw，然后再回来安装 TeamClaw。",
      "bootstrap.openclawInstallLabel": "OpenClaw 一键安装命令",
      "bootstrap.openclawQuickstartLabel": "OpenClaw 引导式 quickstart 命令",
      "bootstrap.openclawInstallNow": "立即安装 OpenClaw",
      "bootstrap.teamclawInstallLabel": "TeamClaw 一行安装命令",
      "bootstrap.teamclawDetectedTitle": "本机已安装 OpenClaw，但本地 TeamClaw controller 目前不可用。",
      "bootstrap.teamclawDetectedSubtitle": "你可以把 TeamClaw 安装到本机 OpenClaw 里，或者把这个桌面端改连到别的 controller。",
      "bootstrap.startLocal": "启动本地 controller",
      "bootstrap.startingLocal": "启动中…",
      "bootstrap.remoteTitle": "或者连接到其他 controller",
      "bootstrap.remoteHint": "你也可以把这个桌面端直接连接到远端 TeamClaw controller。",
      "bootstrap.remoteUrl": "Controller 地址",
      "bootstrap.connectRemote": "连接这个 controller",
      "bootstrap.copied": "已复制",
      "bootstrap.modeWarning": "这个模式会更多地占用当前机器资源，但本地 worker 的进程隔离更强。",
      "bootstrap.manualWarning": "这个模式一样能在本机直接执行任务；TeamClaw 会按需拉起本地 worker 进程，只是默认 worker 池配置更精简。",
      "bootstrap.logs": "本地 controller 活动",
      "bootstrap.startCommand": "OpenClaw 引导式 quickstart 命令",
      "bootstrap.componentsLabel": "拆件安装命令",
      "worker.add": "添加 worker",
      "worker.hide": "隐藏 worker 命令",
      "worker.cardTitle": "注册新的外部 worker",
      "worker.cardSubtitle": "为另一台机器生成一行式 worker 安装命令。",
      "worker.role": "角色",
      "worker.discovery": "Controller 发现方式",
      "worker.discoveryMdns": "局域网自动发现（mDNS）",
      "worker.discoveryManual": "手动填写 controller 地址（局域网 IP）",
      "worker.copy": "复制命令",
      "worker.copied": "已复制",
      "worker.recommendedUrl": "推荐的 controller 地址：",
      "planning.none": "暂无项目。",
      "planning.consensus": "共识",
      "planning.controllerOutput": "Controller 输出",
      "planning.noOutput": "暂无 controller 输出。",
      "action.languageToggleZh": "中文",
      "action.languageToggleEn": "English"
    }
  };

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return document.querySelectorAll(selector); }

  function loadLanguage() {
    try {
      return window.localStorage.getItem(LANGUAGE_KEY) === "zh" ? "zh" : "en";
    } catch {
      return "en";
    }
  }

  function t(key, params) {
    const template = (TRANSLATIONS[state.language] && TRANSLATIONS[state.language][key]) || TRANSLATIONS.en[key] || key;
    return template.replace(/\{(\w+)\}/g, (_, name) => (params && params[name] != null ? String(params[name]) : ""));
  }

  function setLanguage(language) {
    state.language = language === "zh" ? "zh" : "en";
    try {
      window.localStorage.setItem(LANGUAGE_KEY, state.language);
    } catch {}
    document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
    applyStaticTranslations();
    renderChrome();
    renderMissionSummary();
    renderConversation();
    renderPlanning();
    renderTasks();
    renderClarifications();
    renderWorkspaceTree();
    renderWorkspaceContent();
    renderReports();
    renderRuntimeAlert();
    renderExternalWorkerInstallToggle();
    renderExternalWorkerInstallCard();
    renderUnavailableScreen();
  }

  function applyStaticTranslations() {
    const languageToggle = $("#language-toggle");
    if (languageToggle) {
      languageToggle.textContent = state.language === "zh" ? t("action.languageToggleEn") : t("action.languageToggleZh");
    }
    const texts = [
      [".connection-card h2", "connection.controller"],
      [".nav-btn[data-view='mission'] .nav-label", "mission.title"],
      [".nav-btn[data-view='planning'] .nav-label", "tab.planning"],
      [".nav-btn[data-view='tasks'] .nav-label", "tab.tasks"],
      [".nav-btn[data-view='clarifications'] .nav-label", "tab.clarifications"],
      [".nav-btn[data-view='workspace'] .nav-label", "tab.workspace"],
      [".nav-btn[data-view='reports'] .nav-label", "tab.reports"],
      ["#compose-focus-btn", "mission.newRequirement"],
      ["#notice-toggle", "mission.notifications"],
      ["#view-mission .section-head h2", "mission.requirement"],
      ["#view-mission .view-grid .panel.large-card:nth-of-type(2) .section-head h2", "mission.summary"],
      [".conversation-card .section-head h2", "mission.recentInteraction"],
      ["#planning-list.closest", "planning.runs"],
      ["#bootstrap-title", "bootstrap.title"],
      ["#bootstrap-subtitle", "bootstrap.subtitle"],
      ["#bootstrap-status-label", "bootstrap.status"],
      ["#bootstrap-mode-label", "bootstrap.mode"],
      ["#bootstrap-command-label", "bootstrap.command"],
      ["#bootstrap-remote-title", "bootstrap.remoteTitle"],
      ["#bootstrap-remote-hint", "bootstrap.remoteHint"],
      ["#bootstrap-remote-url-label", "bootstrap.remoteUrl"],
      ["#bootstrap-logs-label", "bootstrap.componentsLabel"],
      ["#bootstrap-start-command-label", "bootstrap.startCommand"]
    ];
    texts.forEach(([selector, key]) => {
      if (selector === "#planning-list.closest") {
        const heading = $("#planning-list") && $("#planning-list").closest(".panel") ? $("#planning-list").closest(".panel").querySelector(".section-head h2") : null;
        if (heading) heading.textContent = t(key);
        return;
      }
      const element = $(selector);
      if (element) element.textContent = t(key);
    });
    const summary = $("#summary-grid .empty-state");
    if (summary && summary.textContent.indexOf("controller") !== -1) summary.textContent = t("mission.connectHint");
    const planningEmpty = $("#planning-detail .empty-state");
    if (planningEmpty && planningEmpty.textContent.indexOf("planning run") !== -1) planningEmpty.textContent = t("planning.empty");
  }

  function normalizeBaseUrl(input) {
    const raw = String(input || "").trim().replace(/\/+$/, "");
    if (!raw) return "";
    if (/^https?:\/\//i.test(raw)) return raw;
    return `http://${raw}`;
  }

  function isLoopbackControllerUrl(input) {
    try {
      const url = new URL(normalizeBaseUrl(input));
      return url.hostname === "127.0.0.1" || url.hostname === "localhost";
    } catch {
      return false;
    }
  }

  function selectedLocalSetupMode() {
    const modes = normalizeArray(state.localSetupInfo && state.localSetupInfo.modes);
    return modes.find((entry) => entry.id === state.localSetupMode) || modes[0] || null;
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value == null ? "" : value);
    return div.innerHTML;
  }

  async function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
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

  function compactText(value, limit) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > (limit || 120) ? `${text.slice(0, limit || 120).trimEnd()}…` : text;
  }

  function roleTone(role) {
    const key = String(role || "").toLowerCase();
    if (key.includes("architect")) return "architect";
    if (key.includes("developer") || key.includes("engineer")) return "developer";
    if (key.includes("qa") || key.includes("test")) return "qa";
    if (key.includes("design")) return "design";
    if (key.includes("product") || key.includes("pm")) return "product";
    if (key.includes("security")) return "security";
    if (key.includes("devops") || key.includes("platform") || key.includes("infra")) return "devops";
    if (key.includes("research") || key.includes("analyst")) return "research";
    return "neutral";
  }

  function renderRoleChip(role) {
    return `<span class="role-chip tone-${escapeHtml(roleTone(role))}">${escapeHtml(humanize(role || "role"))}</span>`;
  }

  function statusTone(value) {
    const status = String(value || "").toLowerCase();
    if (status === "pending" || status === "queued" || status === "not_started" || status === "created") return "pending";
    if (status === "assigned" || status === "in_progress" || status === "review" || status === "active" || status === "running" || status === "working" || status === "executing") return "active";
    if (status === "blocked") return "blocked";
    if (status === "completed" || status === "done" || status === "delivery") return "completed";
    if (status === "failed" || status === "error") return "failed";
    return "neutral";
  }

  function groupPlanningRuns(runs) {
    const groups = [
      { key: "active", label: t("planning.groupActive"), tones: new Set(["active"]) },
      { key: "pending", label: t("planning.groupPending"), tones: new Set(["pending", "neutral"]) },
      { key: "completed", label: t("planning.groupCompleted"), tones: new Set(["completed"]) },
      { key: "blocked-failed", label: t("planning.groupBlockedFailed"), tones: new Set(["blocked", "failed"]) },
    ].map((group) => ({ ...group, runs: [] }));

    runs.forEach((run) => {
      const tone = statusTone(run.status || "unknown");
      const group = groups.find((entry) => entry.tones.has(tone)) || groups[1];
      group.runs.push(run);
    });
    return groups.filter((group) => group.runs.length > 0);
  }

  function planningGroupKeyForRun(run) {
    const tone = statusTone(run && run.status || "unknown");
    if (tone === "active") return "active";
    if (tone === "completed") return "completed";
    if (tone === "blocked" || tone === "failed") return "blocked-failed";
    return "pending";
  }

  function renderStatusTag(value, label) {
    return `<span class="status-tag tone-${escapeHtml(statusTone(value))}">${escapeHtml(label || humanize(value || "unknown"))}</span>`;
  }

  function renderListIndicator(value) {
    return `<span class="list-indicator tone-${escapeHtml(statusTone(value))}" aria-hidden="true"></span>`;
  }

  function renderMarkdownInline(text) {
    let html = escapeHtml(text || "");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?])/g, "$1<em>$2</em>");
    html = html.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, "$1<em>$2</em>");
    return html;
  }

  function renderMarkdown(text) {
    const source = String(text || "").replace(/\r\n/g, "\n").trim();
    if (!source) return "";

    const lines = source.split("\n");
    const html = [];
    let paragraph = [];
    let listType = "";
    let listItems = [];
    let quoteLines = [];
    let codeLines = null;

    function flushParagraph() {
      if (!paragraph.length) return;
      html.push(`<p>${paragraph.map((line) => renderMarkdownInline(line)).join("<br>")}</p>`);
      paragraph = [];
    }

    function flushList() {
      if (!listItems.length) return;
      html.push(`<${listType}>${listItems.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</${listType}>`);
      listItems = [];
      listType = "";
    }

    function flushQuote() {
      if (!quoteLines.length) return;
      html.push(`<blockquote>${quoteLines.map((line) => renderMarkdownInline(line)).join("<br>")}</blockquote>`);
      quoteLines = [];
    }

    function flushCode() {
      if (!codeLines) return;
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeLines = null;
    }

    for (const rawLine of lines) {
      const line = rawLine.replace(/\t/g, "  ");

      if (/^```/.test(line.trim())) {
        flushParagraph();
        flushList();
        flushQuote();
        if (codeLines) {
          flushCode();
        } else {
          codeLines = [];
        }
        continue;
      }

      if (codeLines) {
        codeLines.push(rawLine);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        flushQuote();
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        flushQuote();
        const level = heading[1].length;
        html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        flushList();
        quoteLines.push(quote[1]);
        continue;
      }

      const ordered = line.match(/^\d+\.\s+(.*)$/);
      const unordered = line.match(/^[-*+]\s+(.*)$/);
      if (ordered || unordered) {
        flushParagraph();
        flushQuote();
        const nextType = ordered ? "ol" : "ul";
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        listItems.push((ordered || unordered)[1]);
        continue;
      }

      flushQuote();
      flushList();
      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    flushQuote();
    flushCode();

    return html.join("");
  }

  function renderMarkdownBlock(text, emptyText) {
    const html = renderMarkdown(text);
    if (!html) {
      return emptyText ? `<div class="empty-state">${escapeHtml(emptyText)}</div>` : "";
    }
    return `<div class="markdown-body">${html}</div>`;
  }

  function renderClarificationAnswerForm(item, scopeKey) {
    const schema = item && item.questionSchema ? item.questionSchema : null;
    const id = String(item && item.id || "");
    const scope = String(scopeKey || "inline");
    if (!schema || !schema.kind) {
      return (
        `<textarea data-clarification-answer="${escapeHtml(id)}" placeholder="${escapeHtml(t("clarification.answerPlaceholder"))}"></textarea>` +
        `<div class="inline-actions"><button class="inline-action" type="button" data-clarification-submit="${escapeHtml(id)}">Send answer</button></div>`
      );
    }

    let controlHtml = "";
    if (schema.kind === "single-select" || schema.kind === "multi-select") {
      const inputType = schema.kind === "single-select" ? "radio" : "checkbox";
      const name = `clarification-choice-${scope}-${id}`;
      const options = Array.isArray(schema.options) ? schema.options : [];
      controlHtml = (
        `<div class="clarification-options">` +
        options.map((option) => (
          `<label class="clarification-option">` +
          `<input type="${inputType}" name="${escapeHtml(name)}" data-clarification-choice="${escapeHtml(id)}" value="${escapeHtml(option.value || '')}">` +
          `<span class="clarification-option-copy"><strong>${escapeHtml(option.label || option.value || '')}</strong>${option.hint ? `<span>${escapeHtml(option.hint)}</span>` : ""}</span>` +
          `</label>`
        )).join("") +
        (schema.allowOther ? (
          `<label class="clarification-option">` +
          `<input type="${inputType}" name="${escapeHtml(name)}" data-clarification-choice="${escapeHtml(id)}" value="__other__">` +
          `<span class="clarification-option-copy"><strong>Other</strong><span>Provide a custom answer.</span></span>` +
          `</label>` +
          `<input class="compact-input" data-clarification-other="${escapeHtml(id)}" placeholder="Custom answer">`
        ) : "") +
        `</div>`
      );
    } else if (schema.kind === "number") {
      const attrs = [
        `type="number"`,
        `class="compact-input clarification-number-input"`,
        `data-clarification-number="${escapeHtml(id)}"`,
        schema.placeholder ? `placeholder="${escapeHtml(schema.placeholder)}"` : "",
        typeof schema.min === "number" ? `min="${schema.min}"` : "",
        typeof schema.max === "number" ? `max="${schema.max}"` : "",
        typeof schema.step === "number" ? `step="${schema.step}"` : "",
      ].filter(Boolean).join(" ");
      controlHtml = `<div class="clarification-number-row"><input ${attrs}>${schema.unit ? `<span class="mini-pill">${escapeHtml(schema.unit)}</span>` : ""}</div>`;
    } else {
      controlHtml = `<textarea data-clarification-answer="${escapeHtml(id)}" placeholder="${escapeHtml(schema.placeholder || t("clarification.answerPlaceholder"))}"></textarea>`;
    }

    const commentPlaceholder = schema.kind === "text"
      ? "Additional context (optional)"
      : "Optional note or extra context";
    const commentField = schema.kind === "text"
      ? ""
      : `<textarea data-clarification-comment="${escapeHtml(id)}" placeholder="${escapeHtml(commentPlaceholder)}"></textarea>`;
    return (
      `<div class="clarification-form" data-clarification-card="${escapeHtml(id)}">` +
      (schema.description ? `<div class="clarification-body"><strong>Input guidance</strong>${renderMarkdownBlock(schema.description)}</div>` : "") +
      controlHtml +
      commentField +
      `<div class="inline-actions"><button class="inline-action" type="button" data-clarification-submit="${escapeHtml(id)}">Send answer</button></div>` +
      `</div>`
    );
  }

  function renderSourceWithLineNumbers(content) {
    const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
    return (
      `<div class="code-view">` +
      lines.map((line, index) => (
        `<div class="code-line">` +
        `<span class="code-gutter">${index + 1}</span>` +
        `<span class="code-text">${escapeHtml(line || " ")}</span>` +
        `</div>`
      )).join("") +
      `</div>`
    );
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
    state.connectionState = kind;
    const el = $("#connection-pill");
    if (!el) return;
    el.className = `pill pill-${kind}`;
    el.textContent = text;
    renderChrome();
  }

  function setStatusLine(text) {
    const el = $("#status-line");
    if (el) el.textContent = text;
  }

  function setSummaryLine(text) {
    const el = $("#summary-line");
    if (el) el.textContent = text;
  }

  /* function renmderRuntimeAlert(modelReadiness) keeps the legacy marker: TeamClaw is installed but cannot work yet. */
  function renderRuntimeAlert() {
    const el = $("#runtime-alert");
    if (!el) return;
    const readiness = state.teamStatus.modelReadiness;
    if (!readiness || readiness.status === "ready") {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    const details = [];
    if (!readiness.hasConfiguredModel) {
      details.push(t("runtime.noModel"));
    }
    if (!readiness.hasAuthProfiles) {
      details.push(t("runtime.noAuth"));
    }
    el.classList.remove("hidden");
    el.innerHTML = `<strong>${escapeHtml(t("runtime.title"))}</strong> ${escapeHtml(readiness.message || details.join(" "))}${details.length ? ` ${escapeHtml(details.join(" "))}` : ""}`;
  }

  function renderExternalWorkerInstallToggle() {
    const button = $('#worker-install-toggle');
    if (!button) return;
    const available = Boolean(state.teamStatus.externalWorkerInstall);
    button.hidden = !available;
    button.disabled = !available;
    button.textContent = state.externalWorkerInstallVisible ? t("worker.hide") : t("worker.add");
    // Source-contract note: keep the legacy English marker after externalWorkerInstallVisible: Add worker.
  }

  function renderUnavailableScreen() {
    const shell = $(".app-shell");
    const overlay = $("#bootstrap-overlay");
    const commandEl = $("#bootstrap-install-command");
    const mode = selectedLocalSetupMode();
    const modeId = mode ? mode.id : state.localSetupMode;
    const hasOpenClaw = Boolean(state.localSetupInfo && state.localSetupInfo.hasOpenClaw);
    const installCommand = hasOpenClaw
      ? (mode && mode.installCommand ? String(mode.installCommand) : "npx -y @teamclaws/teamclaw install --yes --install-mode controller-process")
      : String((state.localSetupInfo && state.localSetupInfo.openClawInstallCommand) || "npm install -g openclaw@latest");
    const quickstartCommand = String((state.localSetupInfo && state.localSetupInfo.openClawQuickstartCommand) || "openclaw onboard --flow quickstart --install-daemon");
    const remoteInput = $("#bootstrap-controller-url");
    const visible = state.unavailableScreenVisible;

    if (shell) shell.classList.toggle("app-shell-blocked", visible);
    if (!overlay) return;
    overlay.classList.toggle("hidden", !visible);
    overlay.setAttribute("aria-hidden", visible ? "false" : "true");
    if (!visible) {
      return;
    }

    overlay.querySelectorAll("[data-bootstrap-mode]").forEach((input) => {
      input.checked = input.getAttribute("data-bootstrap-mode") === modeId;
    });

    if (remoteInput && !remoteInput.value) {
      remoteInput.value = state.controllerUrl || (state.settings && state.settings.controllerUrl) || "http://127.0.0.1:9527";
    }
    if (commandEl) {
      commandEl.textContent = installCommand;
    }

    const startCommandEl = $("#bootstrap-start-command");
    if (startCommandEl) {
      startCommandEl.textContent = quickstartCommand;
    }

    const titleEl = $("#bootstrap-title");
    const subtitleEl = $("#bootstrap-subtitle");
    const commandLabelEl = $("#bootstrap-command-label");
    const nextStepLabelEl = $("#bootstrap-start-command-label");
    const componentsEl = $("#bootstrap-local-log");
    const openClawQuickstartCard = $("#bootstrap-openclaw-quickstart-card");
    const openClawComponentsCard = $("#bootstrap-openclaw-components-card");
    if (titleEl) titleEl.textContent = hasOpenClaw ? t("bootstrap.teamclawDetectedTitle") : t("bootstrap.openclawMissingTitle");
    if (subtitleEl) subtitleEl.textContent = hasOpenClaw ? t("bootstrap.teamclawDetectedSubtitle") : t("bootstrap.openclawMissingSubtitle");
    if (commandLabelEl) commandLabelEl.textContent = hasOpenClaw ? t("bootstrap.teamclawInstallLabel") : t("bootstrap.openclawInstallLabel");
    if (nextStepLabelEl) nextStepLabelEl.textContent = t("bootstrap.openclawQuickstartLabel");
    if (componentsEl) {
      componentsEl.textContent = String((state.localSetupInfo && state.localSetupInfo.openClawInstallCommand) || "npm install -g openclaw@latest");
    }
    if (openClawQuickstartCard) {
      openClawQuickstartCard.classList.toggle("hidden", hasOpenClaw);
    }
    if (openClawComponentsCard) {
      openClawComponentsCard.classList.toggle("hidden", hasOpenClaw);
    }

    const reasonEl = $("#bootstrap-status-detail");
    if (reasonEl) {
      const fallback = state.isConnecting
          ? t("bootstrap.connecting")
          : t("bootstrap.failed");
      reasonEl.textContent = state.unavailableReason || fallback;
    }

    const statusPill = $("#local-pill");
    if (statusPill) {
      statusPill.className = `pill ${hasOpenClaw ? "pill-connected" : "pill-disconnected"}`;
      statusPill.textContent = hasOpenClaw ? "OpenClaw detected" : "OpenClaw missing";
    }

    const modeCard = $("#bootstrap-mode-card");
    if (modeCard) {
      modeCard.classList.toggle("hidden", !hasOpenClaw);
    }

    const warningEl = $("#bootstrap-mode-warning");
    if (warningEl) {
      const warningText = modeId === "controller-process" ? t("bootstrap.modeWarning") : t("bootstrap.manualWarning");
      warningEl.textContent = warningText;
    }

    const installBtn = $("#bootstrap-install-btn");
    if (installBtn) {
      const busy = hasOpenClaw ? state.isInstallingLocal : state.isInstallingOpenClaw;
      installBtn.disabled = busy;
      installBtn.textContent = busy
        ? t("bootstrap.installing")
        : (hasOpenClaw ? t("bootstrap.installNow") : t("bootstrap.openclawInstallNow"));
    }
    const copyBtn = $('[data-bootstrap-copy-install]');
    if (copyBtn) {
      copyBtn.textContent = t("bootstrap.copyInstall");
    }
    const remoteConnectBtn = $('[data-bootstrap-connect]');
    if (remoteConnectBtn) {
      remoteConnectBtn.textContent = t("bootstrap.connectRemote");
    }

    const manualTitle = $("#bootstrap-mode-manual-title");
    const manualHint = $("#bootstrap-mode-manual-hint");
    const processTitle = $("#bootstrap-mode-process-title");
    const processHint = $("#bootstrap-mode-process-hint");
    if (manualTitle) manualTitle.textContent = t("bootstrap.manualMode");
    if (manualHint) manualHint.textContent = t("bootstrap.manualModeHint");
    if (processTitle) processTitle.textContent = t("bootstrap.processMode");
    if (processHint) processHint.textContent = t("bootstrap.processModeHint");
  }

  function buildExternalWorkerCommand(info, roleId, discoveryMode) {
    if (!info || !roleId) return '';
    const prefix = discoveryMode === 'manual' ? String(info.manualCommandPrefix || '') : String(info.autoDiscoveryCommandPrefix || '');
    const suffix = discoveryMode === 'manual' ? String(info.manualControllerUrlFlag || '') : '';
    return `${prefix}${roleId}${suffix}`.trim();
  }

  function renderExternalWorkerInstallCard() {
    // Source-contract note: keep the legacy English markers "Register a new external worker" and "Copy command".
    const el = $('#external-worker-install');
    if (!el) return;
    const info = state.teamStatus.externalWorkerInstall;
    const roles = normalizeArray(info && info.roles);
    if (!info || !roles.length || !state.externalWorkerInstallVisible) {
      el.classList.add('hidden');
      return;
    }
    if (!roles.some((role) => role.id === state.externalWorkerRole)) {
      state.externalWorkerRole = roles[0].id;
    }
    if (state.externalWorkerDiscoveryMode === 'manual' && !info.recommendedControllerUrl) {
      state.externalWorkerDiscoveryMode = 'mdns';
    }
    const roleOptions = roles.map((role) => (
      `<option value="${escapeHtml(role.id)}"${role.id === state.externalWorkerRole ? ' selected' : ''}>${escapeHtml(`${role.icon ? `${role.icon} ` : ''}${role.label || role.id}`)}</option>`
    )).join('');
    const discoveryOptions = [
      `<option value="mdns"${state.externalWorkerDiscoveryMode === 'mdns' ? ' selected' : ''}>${escapeHtml(t("worker.discoveryMdns"))}</option>`,
      `<option value="manual"${state.externalWorkerDiscoveryMode === 'manual' ? ' selected' : ''}${info.recommendedControllerUrl ? '' : ' disabled'}>${escapeHtml(t("worker.discoveryManual"))}</option>`,
    ].join('');
    const note = state.externalWorkerDiscoveryMode === 'manual'
      ? String(info.manualControllerWarning || '')
      : String(info.autoDiscoveryWarning || '');
    const command = buildExternalWorkerCommand(info, state.externalWorkerRole, state.externalWorkerDiscoveryMode);
    const manualDetail = state.externalWorkerDiscoveryMode === 'manual' && info.recommendedControllerUrl
      ? `<div class="worker-install-note">${escapeHtml(t("worker.recommendedUrl"))}<code>${escapeHtml(info.recommendedControllerUrl)}</code></div>`
      : '';
    el.classList.remove('hidden');
    el.innerHTML = (
      `<div class="worker-install-head">` +
        `<div><h3>${escapeHtml(t("worker.cardTitle"))}</h3><div class="worker-install-subtitle">${escapeHtml(t("worker.cardSubtitle"))}</div></div>` +
        `<button type="button" class="btn worker-install-copy" data-worker-install-copy="true">${escapeHtml(t("worker.copy"))}</button>` +
      `</div>` +
      `<div class="worker-install-controls">` +
        `<div class="worker-install-field"><label for="desktop-worker-install-role">${escapeHtml(t("worker.role"))}</label><select id="desktop-worker-install-role" class="compact-input" data-worker-install-role="true">${roleOptions}</select></div>` +
        `<div class="worker-install-field"><label for="desktop-worker-install-discovery">${escapeHtml(t("worker.discovery"))}</label><select id="desktop-worker-install-discovery" class="compact-input" data-worker-install-discovery="true">${discoveryOptions}</select></div>` +
      `</div>` +
      `<pre class="worker-install-command"><code>${escapeHtml(command)}</code></pre>` +
      manualDetail +
      `<div class="worker-install-note${state.externalWorkerDiscoveryMode === 'manual' ? ' warning' : ''}">${escapeHtml(note)}</div>`
    );
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (!state.controllerUrl || state.reconnectTimer || state.isConnecting || state.unavailableScreenVisible) {
      return;
    }
    const delay = Math.min(1000 * (2 ** Math.min(state.reconnectAttempt, 4)), 10000);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      attemptReconnect().catch(() => {});
    }, delay);
    setConnectionPill("connecting", t("connection.reconnecting"));
    setStatusLine(t("connection.retrying", { seconds: Math.round(delay / 1000) }));
    renderChrome();
  }

  async function attemptReconnect() {
    if (!state.controllerUrl || state.isConnecting) return;
    state.reconnectAttempt += 1;
    try {
      await refreshAll(true);
      connectWs();
    } catch {
      scheduleReconnect();
    }
  }

  function renderChrome() {
    const card = $("#connection-card");
    const body = $("#connection-body");
    const summary = $("#connection-summary");
    const edit = $("#connection-edit-btn");
    const connectBtn = $("#connect-btn");
    const refreshBtn = $("#refresh-btn");
    const drawer = $("#notice-drawer");
    const connected = state.connectionState === "connected";
    const condensed = connected && !state.connectionExpanded;
    if (card) card.classList.toggle("is-condensed", condensed);
    if (body) body.style.display = condensed ? "none" : "";
    if (summary) {
      summary.textContent = connected
        ? state.controllerUrl
        : (state.controllerUrl || t("connection.notConnected"));
    }
    if (edit) {
      edit.hidden = !connected || state.isConnecting;
      edit.textContent = condensed ? t("connection.edit") : t("connection.done");
    }
    if (connectBtn) {
      connectBtn.disabled = state.isConnecting;
      connectBtn.textContent = state.isConnecting ? `${t("connection.connecting")}…` : t("connection.connect");
    }
    if (refreshBtn) {
      refreshBtn.disabled = state.isRefreshing || state.isConnecting || !state.controllerUrl;
      refreshBtn.textContent = state.isRefreshing ? `${t("connection.refresh")}…` : t("connection.refresh");
    }
    if (drawer) {
      drawer.classList.toggle("is-collapsed", !state.noticeDrawerOpen);
    }
    renderActivitySignals();
    renderClarificationPrompt();
    renderUnavailableScreen();
  }

  function activateView(view) {
    const validViews = new Set(["mission", "planning", "tasks", "clarifications", "workspace", "reports"]);
    const nextView = validViews.has(view) ? view : "mission";
    state.currentView = nextView;

    document.querySelectorAll(".nav-btn[data-view]").forEach((button) => {
      button.classList.toggle("active", button.getAttribute("data-view") === nextView);
    });
    document.querySelectorAll(".stage-view").forEach((section) => {
      section.classList.toggle("active", section.id === `view-${nextView}`);
    });

    if (nextView === "planning") {
      renderPlanning();
    } else if (nextView === "tasks") {
      renderTasks();
    } else if (nextView === "clarifications") {
      renderClarifications();
    } else if (nextView === "workspace") {
      renderWorkspaceTree();
      renderWorkspaceContent();
    } else if (nextView === "reports") {
      renderReports();
    } else {
      renderMissionSummary();
      renderConversation();
    }

    renderChrome();
  }

  function normalizeArray(input) {
    return Array.isArray(input) ? input : Object.values(input || {});
  }

  function sortTasks(tasks) {
    return normalizeArray(tasks).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function sortClarifications(items) {
    return normalizeArray(items).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function pendingClarifications() {
    return sortClarifications(state.teamStatus.clarifications).filter((item) => !item.answer);
  }

  function activePlanningRunCount() {
    return normalizeArray(state.teamStatus.controllerRuns).filter((run) => {
      const status = String(run.status || "").toLowerCase();
      return status === "pending" || status === "running";
    }).length;
  }

  function activeTaskCount() {
    return normalizeArray(state.teamStatus.tasks).filter((task) => {
      const status = String(task.status || "").toLowerCase();
      return status === "assigned" || status === "in_progress" || status === "review";
    }).length;
  }

  function blockedTaskCount() {
    return normalizeArray(state.teamStatus.tasks).filter((task) => String(task.status || "").toLowerCase() === "blocked").length;
  }

  function setNavSignal(view, count, tone) {
    const el = document.querySelector(`[data-nav-signal="${CSS.escape(view)}"]`);
    if (!el) return;
    if (!count) {
      el.className = "nav-signal is-hidden";
      el.innerHTML = "";
      return;
    }
    el.className = `nav-signal tone-${tone}`;
    el.innerHTML = `<span class="nav-dot" aria-hidden="true"></span><span class="nav-count">${escapeHtml(String(count))}</span>`;
  }

  function renderActivitySignals() {
    const planningCount = activePlanningRunCount();
    const taskActiveCount = activeTaskCount();
    const taskBlockedCount = blockedTaskCount();
    const clarificationCount = pendingClarifications().length;
    const noticeToggle = $("#notice-toggle");

    setNavSignal("planning", planningCount, "active");
    setNavSignal("tasks", taskActiveCount || taskBlockedCount, taskActiveCount ? "active" : "blocked");
    setNavSignal("clarifications", clarificationCount, "attention");

    if (noticeToggle) {
      noticeToggle.classList.toggle("has-attention", clarificationCount > 0);
    }
  }

  function syncClarificationPrompt(options) {
    const opts = options || {};
    const pending = pendingClarifications();
    state.dismissedClarificationIds = state.dismissedClarificationIds.filter((id) => pending.some((item) => item.id === id));
    if (!pending.length) {
      state.clarificationPromptOpen = false;
      state.activeClarificationId = "";
      renderClarificationPrompt();
      return;
    }

    let targetId = "";
    if (opts.forceId && pending.some((item) => item.id === opts.forceId)) {
      targetId = opts.forceId;
      state.dismissedClarificationIds = state.dismissedClarificationIds.filter((id) => id !== targetId);
    } else if (
      state.clarificationPromptOpen &&
      state.activeClarificationId &&
      pending.some((item) => item.id === state.activeClarificationId)
    ) {
      targetId = state.activeClarificationId;
    } else {
      const nextPending = pending.find((item) => !state.dismissedClarificationIds.includes(item.id));
      targetId = nextPending ? nextPending.id : "";
    }

    state.clarificationPromptOpen = !!targetId;
    state.activeClarificationId = targetId;
    renderClarificationPrompt();
  }

  function renderClarificationPrompt() {
    const modal = $("#clarification-modal");
    const content = $("#clarification-modal-content");
    if (!modal || !content) return;

    const pending = pendingClarifications();
    const active = pending.find((item) => item.id === state.activeClarificationId);
    if (!state.clarificationPromptOpen || !active) {
      modal.classList.add("is-hidden");
      modal.setAttribute("aria-hidden", "true");
      content.innerHTML = "";
      return;
    }

    const run = active.controllerRunId
      ? normalizeArray(state.teamStatus.controllerRuns).find((entry) => entry.id === active.controllerRunId)
      : null;
    const headline = (active.questionSchema && active.questionSchema.title) || t("clarification.needed");
    const scopeLabel = active.controllerRunId
      ? ((run && ((run.manifest && run.manifest.requirementSummary) || run.title)) || t("clarification.project"))
      : (active.taskId || t("clarification.task"));
    const queueText = pending.length > 1 ? t("clarification.queue.many", { count: pending.length }) : t("clarification.queue.one");
    const openContextAction = active.taskId
      ? `<button class="btn" type="button" data-clarification-open-task="${escapeHtml(active.taskId)}">${escapeHtml(t("clarification.openTask"))}</button>`
      : (active.controllerRunId ? `<button class="btn" type="button" data-clarification-open-run="${escapeHtml(active.controllerRunId)}">${escapeHtml(t("clarification.openPlanning"))}</button>` : "");

    content.innerHTML = (
      `<div class="clarification-modal-head">` +
      `<div>` +
      `<div class="clarification-modal-kicker">${escapeHtml(t("clarification.humanInput"))}</div>` +
      `<h2 class="clarification-modal-title">${escapeHtml(headline)}</h2>` +
      `<div class="clarification-modal-meta">` +
      `<span class="clarification-queue-pill">${escapeHtml(queueText)}</span>` +
      `<span class="mini-pill">${escapeHtml(scopeLabel)}</span>` +
      `<span class="mini-pill">${escapeHtml(formatDateTime(active.updatedAt || active.createdAt))}</span>` +
      `</div>` +
      `</div>` +
      `<button class="mini-btn" type="button" data-clarification-later="${escapeHtml(active.id)}">${escapeHtml(t("clarification.later"))}</button>` +
      `</div>` +
      `<div class="clarification-modal-body">` +
      `<article class="clarification-card">` +
      `<div class="clarification-body"><strong>${escapeHtml(t("clarification.question"))}</strong>${renderMarkdownBlock(active.question)}</div>` +
      `<div class="clarification-body"><strong>${escapeHtml(t("clarification.whyBlocked"))}</strong>${renderMarkdownBlock(active.blockingReason)}</div>` +
      (active.context ? `<div class="clarification-body"><strong>${escapeHtml(t("clarification.context"))}</strong>${renderMarkdownBlock(active.context)}</div>` : "") +
      `${renderClarificationAnswerForm(active, 'modal')}` +
      `</article>` +
      `</div>` +
      `<div class="clarification-modal-actions">` +
      `<div class="detail-subtitle">This clarification is blocking progress until someone confirms it.</div>` +
      `<div class="row-actions">${openContextAction}<button class="btn" type="button" data-clarification-switch-view="clarifications">Open clarifications page</button></div>` +
      `</div>`
    );
    modal.classList.remove("is-hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function isTaskTerminal(status) {
    const value = String(status || "").toLowerCase();
    return value === "completed" || value === "failed" || value === "blocked";
  }

  function upsertTaskState(task) {
    if (!task || !task.id) return;
    const tasks = normalizeArray(state.teamStatus.tasks);
    const existingIndex = tasks.findIndex((entry) => entry.id === task.id);
    if (existingIndex >= 0) {
      tasks[existingIndex] = { ...tasks[existingIndex], ...task };
    } else {
      tasks.unshift(task);
    }
    state.teamStatus.tasks = sortTasks(tasks);
  }

  function upsertClarificationState(item) {
    if (!item || !item.id) return;
    const clarifications = normalizeArray(state.teamStatus.clarifications);
    const existingIndex = clarifications.findIndex((entry) => entry.id === item.id);
    if (existingIndex >= 0) {
      clarifications[existingIndex] = { ...clarifications[existingIndex], ...item };
    } else {
      clarifications.unshift(item);
    }
    state.teamStatus.clarifications = sortClarifications(clarifications);
  }

  function upsertControllerRunState(run) {
    if (!run || !run.id) return;
    const runs = normalizeArray(state.teamStatus.controllerRuns);
    const existingIndex = runs.findIndex((entry) => entry.id === run.id);
    if (existingIndex >= 0) {
      runs[existingIndex] = { ...runs[existingIndex], ...run };
    } else {
      runs.unshift(run);
    }
    state.teamStatus.controllerRuns = runs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function getTaskProjectKey(task) {
    return task.controllerSessionKey || task.projectDir || "ungrouped";
  }

  function getProjectLabelForTasks(projectKey, projectTasks) {
    const representative = projectTasks[0] || {};
    const matchingRun = normalizeArray(state.teamStatus.controllerRuns).find((run) => {
      return run.sessionKey === projectKey || (representative.projectDir && run.projectDir === representative.projectDir);
    });
    if (matchingRun && matchingRun.manifest && matchingRun.manifest.requirementSummary) {
      return matchingRun.manifest.requirementSummary;
    }
    if (matchingRun && matchingRun.title) {
      return matchingRun.title;
    }
    if (representative.projectDir) {
      return representative.projectDir;
    }
    return "Standalone tasks";
  }

  function groupTasksByProject(tasks) {
    const groups = new Map();
    tasks.forEach((task) => {
      const key = getTaskProjectKey(task);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(task);
    });
    return Array.from(groups.entries())
      .map(([key, projectTasks]) => ({
        key,
        title: getProjectLabelForTasks(key, projectTasks),
        tasks: projectTasks.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        updatedAt: Math.max(...projectTasks.map((task) => task.updatedAt || 0)),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function buildTaskLiveMeta(task) {
    return [humanize(task.status || "unknown"), task.assignedWorkerId, formatTime(task.updatedAt)].filter(Boolean).join(" • ");
  }

  function applyLiveTaskUpdate(task) {
    if (!task || task.id !== state.selectedTaskId) return;
    if (state.taskDetailData && state.taskDetailData.task && state.taskDetailData.task.id === task.id) {
      state.taskDetailData.task = { ...state.taskDetailData.task, ...task };
    }
    const detail = $("#task-detail");
    if (!detail) return;
    const statusEl = detail.querySelector("[data-task-hero-status]");
    const metaEl = detail.querySelector("[data-task-live-meta]");
    if (statusEl) {
      statusEl.innerHTML = renderStatusTag(task.status || "unknown");
    }
    if (metaEl) {
      metaEl.textContent = buildTaskLiveMeta(task);
    }
  }

  function renderTaskExecutionEventEntry(event) {
    return `<article class="timeline-entry live-event"><div class="timeline-head"><div class="task-event-title">${escapeHtml(humanize(event.type || event.phase || "event"))}</div><span class="entry-meta">${escapeHtml(formatDateTime(event.createdAt))}</span></div>${renderMarkdownBlock(event.message || "")}</article>`;
  }

  function appendLiveTaskExecution(event) {
    if (!event || !state.selectedTaskId) return;
    if (state.taskDetailData && state.taskDetailData.task && state.taskDetailData.task.id === state.selectedTaskId) {
      const events = normalizeArray(state.taskDetailData.events);
      state.taskDetailData.events = [...events, event].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    }
    const timeline = $("#task-detail [data-task-timeline]");
    const panel = $("#task-detail [data-task-detail-panel]");
    if (!timeline || !panel) return;
    const shouldFollow = state.taskTimelineAutoFollow || isNearBottom(panel);
    const empty = timeline.querySelector(".empty-state");
    if (empty) {
      empty.remove();
    }
    timeline.insertAdjacentHTML("beforeend", renderTaskExecutionEventEntry(event));
    if (shouldFollow) {
      state.taskTimelineAutoFollow = true;
      requestAnimationFrame(() => scrollTaskDetailPanelToBottom());
    }
  }

  function isNearBottom(element) {
    if (!element) return true;
    return (element.scrollHeight - element.scrollTop - element.clientHeight) < 48;
  }

  function scrollTaskDetailPanelToBottom() {
    const panel = $("#task-detail [data-task-detail-panel]");
    if (!panel) return;
    panel.scrollTop = panel.scrollHeight;
  }

  function syncTaskTimelineFollowState() {
    if (state.selectedTaskDetailTab !== "timeline") return;
    const panel = $("#task-detail [data-task-detail-panel]");
    if (!panel) return;
    state.taskTimelineAutoFollow = isNearBottom(panel);
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

  function renderTaskDetailTab(label, tab, count) {
    const active = state.selectedTaskDetailTab === tab ? " active" : "";
    return (
      `<button type="button" class="task-detail-tab${active}" data-task-detail-tab="${escapeHtml(tab)}">` +
      `${escapeHtml(label)}` +
      `<span class="task-tab-count">${escapeHtml(String(count))}</span>` +
      `</button>`
    );
  }

  function renderTaskTimeline(events) {
    return `<div class="timeline" data-task-timeline>${events.length ? events.map((event) => renderTaskExecutionEventEntry(event)).join("") : '<div class="empty-state">No execution events yet.</div>'}</div>`;
  }

  function renderTaskMessages(messages) {
    return messages.length
      ? messages.map((message) => (
        `<article class="timeline-entry">` +
        `<div class="timeline-head"><strong>${escapeHtml(message.from || "message")}</strong><span class="entry-meta">${escapeHtml(formatDateTime(message.createdAt))}</span></div>` +
        `${renderMarkdownBlock(message.content)}` +
        `</article>`
      )).join("")
      : '<div class="empty-state">No task-linked messages.</div>';
  }

  function renderTaskClarificationHistory(items) {
    return items.length
      ? items.map((item) => (
        `<article class="timeline-entry">` +
        `<div class="timeline-head"><div>${renderStatusTag(item.status || 'pending')}</div><span class="entry-meta">${escapeHtml(formatDateTime(item.updatedAt || item.createdAt))}</span></div>` +
        `<div class="clarification-body"><strong>${escapeHtml(t("clarification.question"))}</strong>${renderMarkdownBlock(item.question)}</div>` +
        `<div class="clarification-body"><strong>${escapeHtml(t("clarification.whyBlocked"))}</strong>${renderMarkdownBlock(item.blockingReason)}</div>` +
        (item.context ? `<div class="clarification-body"><strong>${escapeHtml(t("clarification.context"))}</strong>${renderMarkdownBlock(item.context)}</div>` : "") +
        (item.answer
          ? `<div class="clarification-body"><strong>${escapeHtml(t("clarification.answer"))}</strong>${renderMarkdownBlock(item.answer)}</div>`
          : renderClarificationAnswerForm(item, "task-detail")) +
        `</article>`
      )).join("")
      : `<div class="empty-state">${escapeHtml(t("clarification.historyEmpty"))}</div>`;
  }

  function renderTaskOverview(data) {
    const task = data.task || {};
    const resultContract = task.resultContract || {};
    const deliverables = normalizeArray(resultContract.deliverables);
    const keyPoints = normalizeArray(resultContract.keyPoints);
    return (
      `<section class="detail-block subtle-card"><div class="detail-kicker">Description</div>${renderMarkdownBlock(task.description, "No description provided.")}</section>` +
      (resultContract.summary ? `<section class="detail-block subtle-card"><div class="detail-kicker">Outcome summary</div>${renderMarkdownBlock(resultContract.summary)}</section>` : "") +
      (keyPoints.length ? `<section class="detail-block subtle-card"><div class="detail-kicker">Key points</div><div class="markdown-body"><ul>${keyPoints.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</ul></div></section>` : "") +
      (deliverables.length ? `<section class="detail-block subtle-card"><div class="detail-kicker">Deliverables</div><div class="task-pill-grid">${deliverables.map((item) => `<span class="task-pill">${escapeHtml(item.kind || "artifact")}: ${escapeHtml(item.value || item.path || "")}</span>`).join("")}</div></section>` : "") +
      (!resultContract.summary && !keyPoints.length && !deliverables.length
        ? `<section class="detail-block subtle-card"><div class="empty-state">No outcome artifacts yet.</div></section>`
        : "")
    );
  }

  function renderTaskDetailContent() {
    const detail = $("#task-detail");
    if (!detail || !state.taskDetailData) return;
    const data = state.taskDetailData;
    const task = data.task || {};
    const messages = normalizeArray(data.messages);
    const clarifications = normalizeArray(data.clarifications);
    const events = normalizeArray(data.events);
    const panel = detail.querySelector("[data-task-detail-panel]");
    if (!panel) return;

    let content = "";
    if (state.selectedTaskDetailTab === "timeline") {
      content = renderTaskTimeline(events);
    } else if (state.selectedTaskDetailTab === "clarifications") {
      content = renderTaskClarificationHistory(clarifications);
    } else if (state.selectedTaskDetailTab === "messages") {
      content = renderTaskMessages(messages);
    } else {
      content = renderTaskOverview(data);
    }
    panel.innerHTML = content;
    panel.onscroll = syncTaskTimelineFollowState;

    const tabs = detail.querySelector("[data-task-detail-tabs]");
    if (tabs) {
      tabs.innerHTML = [
        renderTaskDetailTab(t("task.details"), "overview", 0),
        renderTaskDetailTab(t("task.timeline"), "timeline", events.length),
        renderTaskDetailTab(t("tab.clarifications"), "clarifications", clarifications.length),
        renderTaskDetailTab(t("task.messages"), "messages", messages.length),
      ].join("");
    }

    const titleEl = detail.querySelector("[data-task-detail-title]");
    const roleEl = detail.querySelector("[data-task-detail-role]");
    const pillRowEl = detail.querySelector("[data-task-detail-pills]");
    if (titleEl) titleEl.textContent = task.title || task.id || t("task.title");
    if (roleEl) {
      roleEl.innerHTML = task.assignedRole ? renderRoleChip(task.assignedRole) : `<span class="mini-pill">${escapeHtml(t("task.auto"))}</span>`;
    }
    if (pillRowEl) {
      pillRowEl.innerHTML = [task.priority, task.assignedWorkerId].filter(Boolean).map((v) => `<span class="mini-pill">${escapeHtml(v)}</span>`).join("");
    }

    if (state.selectedTaskDetailTab === "timeline" && state.taskTimelineAutoFollow) {
      requestAnimationFrame(() => scrollTaskDetailPanelToBottom());
    }
  }

  function renderTaskDetailShell(data) {
    const detail = $("#task-detail");
    if (!detail) return;
    const task = data.task || {};
    detail.innerHTML = (
      `<div class="task-detail-shell">` +
      `<section class="detail-block task-hero task-detail-header">` +
      `<div class="detail-kicker">${escapeHtml(t("task.title"))}</div>` +
      `<div class="list-headline"><div class="detail-title" data-task-detail-title>${escapeHtml(task.title || task.id || t("task.title"))}</div><div data-task-hero-status>${renderStatusTag(task.status || "unknown")}</div></div>` +
      `<div class="task-meta-row"><div data-task-detail-role>${task.assignedRole ? renderRoleChip(task.assignedRole) : `<span class="mini-pill">${escapeHtml(t("task.auto"))}</span>`}</div><div class="pill-row" data-task-detail-pills>${[task.priority, task.assignedWorkerId].filter(Boolean).map((v) => `<span class="mini-pill">${escapeHtml(v)}</span>`).join("")}</div></div>` +
      `<div class="detail-subtitle" data-task-live-meta>${escapeHtml(buildTaskLiveMeta(task))}</div>` +
      `</section>` +
      `<div class="task-detail-tabs" data-task-detail-tabs></div>` +
      `<section class="task-detail-panel" data-task-detail-panel></section>` +
      `</div>`
    );
    renderTaskDetailContent();
  }

  function upsertTaskDetailClarification(item) {
    if (!item || !item.taskId || !state.taskDetailData || !state.taskDetailData.task) return;
    if (item.taskId !== state.taskDetailData.task.id) return;
    const map = new Map(normalizeArray(state.taskDetailData.clarifications).map((entry) => [entry.id, entry]));
    map.set(item.id, { ...(map.get(item.id) || {}), ...item });
    state.taskDetailData.clarifications = Array.from(map.values()).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  }

  function appendTaskDetailMessage(message) {
    if (!message || !message.taskId || !state.taskDetailData || !state.taskDetailData.task) return;
    if (message.taskId !== state.taskDetailData.task.id) return;
    state.taskDetailData.messages = [...normalizeArray(state.taskDetailData.messages), message].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  function renderMissionSummary() {
    const summary = summarize(state.teamStatus);
    setSummaryLine(`${summary.workers} workers • ${summary.pending} pending • ${summary.active} active • ${summary.completed} completed`);

    const grid = $("#summary-grid");
    if (!grid) return;
    grid.innerHTML = [
      [t("summary.workers"), summary.workers],
      [t("summary.pending"), summary.pending],
      [t("summary.blocked"), summary.blocked],
      [t("summary.completed"), summary.completed],
    ].map(([label, value]) => {
      return `<div class="metric-card"><span class="metric-label">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
    }).join("");
  }

  function renderPlanning() {
    const list = $("#planning-list");
    const detail = $("#planning-detail");
    const runs = normalizeArray(state.teamStatus.controllerRuns).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const selectedRun = runs.find((run) => run.id === state.selectedPlanningRunId) || runs[0] || null;
    if (selectedRun && !state.selectedPlanningRunId) {
      state.selectedPlanningRunId = selectedRun.id;
    }
    const selectedGroupKey = selectedRun ? planningGroupKeyForRun(selectedRun) : "";

    if (list) {
      if (!runs.length) {
        list.innerHTML = `<div class="empty-state">${escapeHtml(t("planning.none"))}</div>`;
      } else {
        list.innerHTML = groupPlanningRuns(runs).map((group) => {
          const collapsed = group.key === selectedGroupKey ? false : !!state.planningGroupCollapsed[group.key];
          return (
            `<section class="planning-run-group tone-${escapeHtml(group.key === "blocked-failed" ? "blocked" : group.key)}">` +
            `<button type="button" class="planning-group-toggle" data-planning-group-toggle="${escapeHtml(group.key)}" aria-expanded="${collapsed ? "false" : "true"}">` +
            `<span class="planning-group-meta">` +
            `<span class="planning-group-title">${escapeHtml(group.label)}</span>` +
            `<span class="planning-group-count">${escapeHtml(String(group.runs.length))}</span>` +
            `</span>` +
            `<span class="planning-group-arrow" aria-hidden="true">${collapsed ? "▸" : "▾"}</span>` +
            `</button>` +
            `<div class="planning-group-items${collapsed ? " is-collapsed" : ""}">` +
            group.runs.map((run) => {
              const selected = run.id === state.selectedPlanningRunId ? " active" : "";
              const tone = statusTone(run.status || "unknown");
              const summary = (run.manifest && (run.manifest.requirementSummary || run.manifest.projectName)) || run.title || run.id;
              return (
                `<button type="button" class="list-item planning-run-card tone-${escapeHtml(tone)}${selected}" data-planning-id="${escapeHtml(run.id)}">` +
                `<div class="compact-list-row">` +
                `${renderListIndicator(run.status || "unknown")}` +
                `<div class="list-copy">` +
                `<div class="list-title">${escapeHtml(run.title || run.id || t("planning.runFallback"))}</div>` +
                `<div class="list-meta">${escapeHtml(compactText(summary, 120))}</div>` +
                `</div>` +
                `${renderStatusTag(run.status || "unknown")}` +
                `</div>` +
                `</button>`
              );
            }).join("") +
            `</div>` +
            `</section>`
          );
        }).join("");
      }
    }

    if (!detail) return;
    if (!selectedRun) {
      detail.innerHTML = `<div class="empty-state">${escapeHtml(t("planning.empty"))}</div>`;
      return;
    }
    const manifest = selectedRun.manifest || {};
    const kickoffPlan = manifest.kickoffPlan || {};
    const createdTasks = normalizeArray(manifest.createdTasks);
    const deferredTasks = normalizeArray(manifest.deferredTasks);
    const clarificationQuestions = normalizeArray(manifest.clarificationQuestions);
    const requiredRoles = normalizeArray(manifest.requiredRoles);
    const candidateRoles = normalizeArray(kickoffPlan.candidateRoles);
    const assessments = normalizeArray(kickoffPlan.assessments);
    const controllerOutput = selectedRun.output || selectedRun.reply || "";
    const roleCount = requiredRoles.length || candidateRoles.length;
    const metaLine = [manifest.projectName, formatDateTime(selectedRun.updatedAt)].filter(Boolean).join(" • ");
    detail.innerHTML = (
      `<div class="planning-detail-shell">` +
      `<section class="planning-hero">` +
      `<div class="detail-kicker">${escapeHtml(t("planning.requirement"))}</div>` +
      `<div class="detail-title">${escapeHtml(manifest.requirementSummary || selectedRun.title || selectedRun.id || t("planning.runFallback"))}</div>` +
      `<div class="detail-subtitle">${escapeHtml(metaLine)}</div>` +
      (requiredRoles.length
        ? `<div class="role-chip-row">${requiredRoles.map((role) => renderRoleChip(role)).join("")}</div>`
        : "") +
      `<div class="planning-facts-grid">` +
      renderPlanningFact(t("planning.complexity"), kickoffPlan.complexity || humanize(selectedRun.status || "unknown")) +
      renderPlanningFact(t("planning.createdTasks"), String(createdTasks.length)) +
      renderPlanningFact(t("planning.requiredRoles"), String(roleCount || 0)) +
      `</div>` +
      `</section>` +
      `<div class="planning-columns">` +
      `<div class="planning-main-column">` +
      `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.originalRequest"))}</div>${renderMarkdownBlock(selectedRun.request || manifest.requirementSummary || "")}</section>` +
      (kickoffPlan.summary
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.consensus"))}</div>${renderMarkdownBlock(kickoffPlan.summary)}</section>`
        : "") +
      (assessments.length
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.assessments"))}</div>${renderPlanningAssessments(assessments)}</section>`
        : "") +
      `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.controllerOutput"))}</div>${renderMarkdownBlock(controllerOutput, t("planning.noControllerOutput"))}</section>` +
      `</div>` +
      `<div class="planning-side-column">` +
      (candidateRoles.length
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.candidateRoles"))}</div><div class="role-chip-row">${candidateRoles.map((role) => renderRoleChip(role)).join("")}</div></section>`
        : "") +
      (createdTasks.length
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.createdTasks"))}</div>${renderPlanningCreatedTasks(createdTasks)}</section>`
        : "") +
      (deferredTasks.length
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.deferredTasks"))}</div>${renderPlanningDeferredTasks(deferredTasks)}</section>`
        : "") +
      (clarificationQuestions.length
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.clarificationsNeeded"))}</div>${renderPlanningQuestionList(clarificationQuestions)}</section>`
        : "") +
      (manifest.handoffPlan
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.handoffPlan"))}</div>${renderMarkdownBlock(manifest.handoffPlan)}</section>`
        : "") +
      (manifest.notes
        ? `<section class="subtle-card"><div class="detail-kicker">${escapeHtml(t("planning.notes"))}</div>${renderMarkdownBlock(manifest.notes)}</section>`
        : "") +
      `</div>` +
      `</div>` +
      `</div>`
    );
  }

  function renderPlanningFact(label, value) {
    return (
      `<div class="subtle-card">` +
      `<span class="fact-label">${escapeHtml(label)}</span>` +
      `<div>${escapeHtml(String(value || "—"))}</div>` +
      `</div>`
    );
  }

  function renderPlanningCreatedTasks(tasks) {
    return (
      `<div class="task-pill-grid">` +
      tasks.map((task) => {
        const role = task.assignedRole ? ` · ${humanize(task.assignedRole)}` : "";
        return `<span class="task-pill">${escapeHtml((task.title || t("task.title")) + role)}</span>`;
      }).join("") +
      `</div>` +
      `<div class="markdown-body"><ul>` +
      tasks.map((task) => `<li>${renderMarkdownInline(task.expectedOutcome || task.title || t("task.title"))}</li>`).join("") +
      `</ul></div>`
    );
  }

  function renderPlanningDeferredTasks(tasks) {
    return `<div class="markdown-body"><ul>${
      tasks.map((task) => {
        const prefix = [task.assignedRole ? humanize(task.assignedRole) : "", task.title || ""].filter(Boolean).join(": ");
        const suffix = [task.blockedBy, task.whenReady].filter(Boolean).join(" — ");
        return `<li>${escapeHtml(prefix || t("task.title"))}${suffix ? `<div>${escapeHtml(suffix)}</div>` : ""}</li>`;
      }).join("")
    }</ul></div>`;
  }

  function renderPlanningQuestionList(items) {
    return `<div class="markdown-body"><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
  }

  function renderPlanningAssessments(assessments) {
    return `<div class="assessment-grid">${
      assessments.map((assessment) => {
        const tone = roleTone(assessment.role);
        return (
          `<article class="assessment-card tone-${escapeHtml(tone)}">` +
          `<div class="list-headline">` +
          `<div>` +
          `<div class="detail-title">${escapeHtml(humanize(assessment.role || "role"))}</div>` +
          `</div>` +
          `${renderStatusTag(assessment.needed ? "completed" : "neutral", assessment.needed ? "Needed" : "Not needed")}` +
          `</div>` +
          (assessment.scope
            ? `<div class="assessment-subsection"><span class="fact-label">${escapeHtml(t("planning.scope"))}</span>${renderMarkdownBlock(assessment.scope)}</div>`
            : "") +
          renderPlanningAssessmentList(t("planning.suggestedTasks"), assessment.suggestedTasks, "task-pill") +
          renderPlanningAssessmentList(t("planning.dependencies"), assessment.dependencies, "task-pill subtle") +
          renderPlanningAssessmentList(t("planning.risks"), assessment.risks, "task-pill subtle") +
          renderPlanningAssessmentList(t("planning.questions"), assessment.questions, "task-pill subtle") +
          `</article>`
        );
      }).join("")
    }</div>`;
  }

  function renderPlanningAssessmentList(label, items, pillClass) {
    const list = normalizeArray(items).filter(Boolean);
    if (!list.length) return "";
    return (
      `<div class="assessment-subsection">` +
      `<span class="fact-label">${escapeHtml(label)}</span>` +
      `<div class="task-pill-grid">${list.map((item) => `<span class="${escapeHtml(pillClass)}">${escapeHtml(item)}</span>`).join("")}</div>` +
      `</div>`
    );
  }

  function renderTasks(options) {
    const opts = options || {};
    const list = $("#task-list");
    const detail = $("#task-detail");
    const filter = String(state.taskFilter || "all").toLowerCase();
    const tasks = sortTasks(state.teamStatus.tasks).filter((task) => filter === "all" || String(task.status || "").toLowerCase() === filter);

    if (list) {
      if (!tasks.length) {
        list.innerHTML = `<div class="empty-state">${escapeHtml(t("task.filter.none"))}</div>`;
      } else {
        list.innerHTML = groupTasksByProject(tasks).map((group) => {
          return (
            `<section class="task-project-group">` +
            `<div class="task-group-title">${escapeHtml(group.title || t("task.groupProject"))}</div>` +
            group.tasks.map((task) => {
              const selected = task.id === state.selectedTaskId ? " active" : "";
              const meta = [task.assignedRole, task.assignedWorkerId, formatTime(task.updatedAt || task.createdAt)].filter(Boolean).join(" • ");
              return (
                `<button type="button" class="list-item task-list-item${selected}" data-task-id="${escapeHtml(task.id)}">` +
                `<div class="compact-list-row">` +
                `${renderListIndicator(task.status || "unknown")}` +
                `<div class="list-copy">` +
                `<div class="list-title">${escapeHtml(task.title || task.id || t("task.title"))}</div>` +
                `<div class="list-meta">${escapeHtml(meta || compactText(task.description, 120))}</div>` +
                `</div>` +
                `${renderStatusTag(task.status || "unknown")}` +
                `</div>` +
                `</button>`
              );
            }).join("") +
            `</section>`
          );
        }).join("");
      }
    }

    const selectedTask = tasks.find((task) => task.id === state.selectedTaskId) || null;
    if (!selectedTask) {
      state.selectedTaskId = "";
      state.taskDetailData = null;
      if (detail && !opts.skipDetail) {
         detail.innerHTML = `<div class="empty-state">${escapeHtml(t("task.selectHint"))}</div>`;
      }
      return;
    }
    if (!opts.skipDetail) {
      renderTaskDetail(selectedTask.id).catch((error) => {
        if (detail) {
          detail.innerHTML = `<div class="empty-state">${escapeHtml(error instanceof Error ? error.message : t("task.failedLoadDetail"))}</div>`;
        }
      });
    }
  }

  async function renderTaskDetail(taskId) {
    if (!taskId) return;
    const detail = $("#task-detail");
    if (detail) {
      detail.innerHTML = `<div class="empty-state">${escapeHtml(t("task.loadingDetail"))}</div>`;
    }
    const data = await apiGet(`/tasks/${encodeURIComponent(taskId)}/execution`);
    state.taskDetailData = {
      task: data.task || null,
      messages: normalizeArray(data.messages),
      clarifications: normalizeArray(data.clarifications),
      events: normalizeArray((data.task && data.task.execution && data.task.execution.events) || []),
    };
    renderTaskDetailShell(state.taskDetailData);
  }

  function renderClarifications() {
    const list = $("#clarification-list");
    if (!list) return;
    const items = sortClarifications(state.teamStatus.clarifications);
    if (!items.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t("clarifications.none"))}</div>`;
      return;
    }
    list.innerHTML = items.map((item) => (
      `<article class="timeline-entry">` +
      `<div class="timeline-head"><div>${renderStatusTag(item.answer ? "completed" : "pending", item.answer ? "answered" : "pending")}</div><span class="entry-meta">${escapeHtml(formatDateTime(item.updatedAt || item.createdAt))}</span></div>` +
      `<div class="clarification-body"><strong>${escapeHtml(t("clarification.question"))}</strong>${renderMarkdownBlock(item.question)}</div>` +
      `<div class="clarification-body"><strong>${escapeHtml(t("clarification.whyBlocked"))}</strong>${renderMarkdownBlock(item.blockingReason)}</div>` +
      (item.context ? `<div class="clarification-body"><strong>${escapeHtml(t("clarification.context"))}</strong>${renderMarkdownBlock(item.context)}</div>` : "") +
      (item.answer
        ? `<div class="clarification-body"><strong>${escapeHtml(t("clarification.answer"))}</strong>${renderMarkdownBlock(item.answer)}</div>`
        : renderClarificationAnswerForm(item, "clarifications")) +
      `</article>`
    )).join("");
  }

  function renderReports() {
    const list = $("#report-list");
    if (!list) return;
    const reports = normalizeArray(state.reports).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
    if (!reports.length) {
      list.innerHTML = `<div class="empty-state">${escapeHtml(t("reports.none"))}</div>`;
      return;
    }
    list.innerHTML = reports.map((report) => {
      const reportKey = report.sessionKey || report.id || "";
      return (
        `<article class="notification-card delivery">` +
        `<div class="notification-head"><div class="notification-headline"><div class="notification-title">${escapeHtml(report.projectName || "Project delivery report")}</div>${renderStatusTag(report.status || "completed")}</div><div class="notification-meta">${escapeHtml(formatDateTime(report.generatedAt))}</div></div>` +
        `<div class="notification-body">${renderMarkdownBlock(report.requirementSummary || "A completion report is available.")}</div>` +
        `<div class="notification-actions"><button type="button" data-open-report="${escapeHtml(reportKey)}">Open report</button></div>` +
        `</article>`
      );
    }).join("");
  }

  function isWorkspacePreviewAvailable(file) {
    return !!file && (file.previewType === "markdown" || file.previewType === "html");
  }

  function findFirstWorkspaceFile(entries) {
    for (const entry of normalizeArray(entries)) {
      if (entry.type === "file") return entry.path || "";
      if (entry.type === "directory") {
        const nested = findFirstWorkspaceFile(entry.children);
        if (nested) return nested;
      }
    }
    return "";
  }

  function renderWorkspaceNodes(entries, depth) {
    const level = Number(depth || 0);
    return `<ul class="${level === 0 ? "tree-root" : "tree-children"}">${
      normalizeArray(entries).map((entry) => {
        if (entry.type === "directory") {
          const children = Array.isArray(entry.children) ? renderWorkspaceNodes(entry.children, level + 1) : '<ul class="tree-children" style="display:none"></ul>';
          return (
            `<li class="tree-node">` +
            `<button type="button" class="tree-row" data-tree-dir="${escapeHtml(entry.path || "")}" data-lazy="${entry.children ? "0" : "1"}">` +
            `<span>${entry.children ? "▾" : "▸"}</span>` +
            `<span>${escapeHtml(entry.name || entry.path || "directory")}</span>` +
            `</button>` +
            `${children}` +
            `</li>`
          );
        }
        const selected = state.selectedWorkspacePath === entry.path ? " selected" : "";
        return (
          `<li class="tree-node">` +
          `<button type="button" class="tree-row${selected} ${selected ? "active" : ""}" data-tree-file="${escapeHtml(entry.path || "")}">` +
          `<span>·</span>` +
          `<span>${escapeHtml(entry.name || entry.path || "file")}</span>` +
          `</button>` +
          `</li>`
        );
      }).join("")
    }</ul>`;
  }

  function mergeWorkspaceChildren(dirPath, entries) {
    const targetPath = String(dirPath || "");
    const updateNode = (items) => normalizeArray(items).map((entry) => {
      if (entry.type === "directory" && entry.path === targetPath) {
        return { ...entry, children: normalizeArray(entries) };
      }
      if (entry.type === "directory" && Array.isArray(entry.children)) {
        return { ...entry, children: updateNode(entry.children) };
      }
      return entry;
    });
    state.workspaceTree = updateNode(state.workspaceTree);
  }

  function renderWorkspaceTree() {
    const tree = $("#workspace-tree");
    if (!tree) return;
    const entries = normalizeArray(state.workspaceTree);
    if (!entries.length) {
      tree.innerHTML = `<div class="empty-state">${escapeHtml(t("workspace.none"))}</div>`;
      return;
    }
    tree.innerHTML = renderWorkspaceNodes(entries, 0);
    if (!state.selectedWorkspacePath) {
      const nextPath = findFirstWorkspaceFile(entries);
      if (nextPath) {
        loadWorkspaceFile(nextPath).catch(() => {});
      }
    }
  }

  async function loadWorkspaceFile(relativePath) {
    if (!relativePath) return;
    const data = await apiGet(`/workspace/file?path=${encodeURIComponent(relativePath)}`);
    state.selectedWorkspacePath = relativePath;
    state.selectedWorkspaceFile = data.file || null;
    if (!isWorkspacePreviewAvailable(state.selectedWorkspaceFile)) {
      state.workspaceView = "source";
    }
    renderWorkspaceTree();
    renderWorkspaceContent();
  }

  function renderWorkspaceContent() {
    const content = $("#workspace-content");
    const fileName = $("#workspace-file-name");
    const fileMeta = $("#workspace-file-meta");
    const sourceBtn = $("#workspace-view-source");
    const previewBtn = $("#workspace-view-preview");
    const file = state.selectedWorkspaceFile;
    if (sourceBtn) sourceBtn.classList.toggle("active", state.workspaceView === "source");
    if (previewBtn) {
      previewBtn.disabled = !isWorkspacePreviewAvailable(file);
      previewBtn.classList.toggle("active", state.workspaceView === "preview" && isWorkspacePreviewAvailable(file));
    }
    if (fileName) fileName.textContent = file ? (file.name || file.path || t("workspace.selectedFile")) : t("workspace.selectFile");
    if (fileMeta) fileMeta.textContent = file ? [file.path, formatBytes(file.size), humanize(file.previewType)].filter(Boolean).join(" • ") : "";
    if (!content) return;
    if (!file) {
      content.innerHTML = `<div class="empty-state">${escapeHtml(t("workspace.selectHint"))}</div>`;
      return;
    }
    if (state.workspaceView === "preview" && file.previewType === "markdown") {
      content.innerHTML = `<div class="preview-shell">${renderMarkdownBlock(file.content)}</div>`;
      return;
    }
    if (state.workspaceView === "preview" && file.previewType === "html" && file.rawUrl) {
      content.innerHTML = `<div class="preview-shell"><iframe class="workspace-preview-frame" sandbox="allow-scripts allow-forms" src="${escapeHtml(file.rawUrl)}"></iframe></div>`;
      return;
    }
    content.innerHTML = `<div class="file-shell">${renderSourceWithLineNumbers(file.content || "")}</div>`;
  }

  function renderConversation() {
    const el = $("#conversation-list");
    if (!el) return;
    const items = state.conversation.filter((entry) => entry.from !== "system");
    if (items.length === 0) {
      el.innerHTML = `<div class="empty-state">${escapeHtml(t("mission.noConversation"))}</div>`;
      return;
    }
    el.innerHTML = items.slice().reverse().map((entry) => {
      return (
        `<article class="conversation-entry ${escapeHtml(entry.from)}">` +
        `  <div class="entry-meta">${escapeHtml(humanize(entry.from))} • ${escapeHtml(formatDateTime(entry.createdAt))}</div>` +
        `  <div class="entry-body">${renderMarkdownBlock(entry.content)}</div>` +
        `</article>`
      );
    }).join("");
  }

  function upsertNotification(item, options) {
    const opts = options || {};
    const incrementCount = opts.incrementCount !== false;
    const nextUpdatedAt = item.updatedAt || Date.now();
    const existing = state.notifications.find((entry) => entry.id === item.id);
    const isNew = !existing;
    if (existing) {
      Object.assign(existing, item, {
        updatedAt: incrementCount ? Date.now() : Math.max(existing.updatedAt || 0, nextUpdatedAt),
        count: incrementCount ? (existing.count || 1) + 1 : (existing.count || 1),
      });
    } else {
      state.notifications.unshift({ updatedAt: nextUpdatedAt, count: 1, ...item });
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
    const categoryCounts = state.notifications.reduce((acc, item) => {
      const key = item.category || "active";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const attentionEl = $("#attention-count");
    const activeEl = $("#active-count");
    const deliveryEl = $("#delivery-count");
    const badge = $("#notice-badge");
    if (attentionEl) attentionEl.textContent = String(categoryCounts.attention || 0);
    if (activeEl) activeEl.textContent = String(categoryCounts.active || 0);
    if (deliveryEl) deliveryEl.textContent = String(categoryCounts.delivery || 0);
    if (badge) {
      const count = (categoryCounts.attention || 0) + (categoryCounts.active || 0) + (categoryCounts.delivery || 0);
      badge.textContent = String(count);
    }
    if (filtered.length === 0) {
      list.innerHTML = '<div class="empty-state">No notifications for this view yet.</div>';
      return;
    }
    list.innerHTML = filtered.map((item) => {
      const actions = Array.isArray(item.actions) ? item.actions : [];
      const meta = [item.meta, item.count > 1 ? `${item.count} updates` : null, formatTime(item.updatedAt)].filter(Boolean).join(" • ");
      return (
        `<article class="notification-card ${escapeHtml(item.category || "active")}">` +
        `  <div class="notification-head"><div class="notification-headline"><div class="notification-title">${escapeHtml(item.title)}</div>${renderStatusTag(item.category || "active", item.category || "active")}</div><div class="notification-meta">${escapeHtml(meta)}</div></div>` +
        `  <div class="notification-body">${renderMarkdownBlock(item.body)}</div>` +
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
        updatedAt: item.updatedAt || item.createdAt,
      }, { incrementCount: false });
    });
    normalizeArray(state.teamStatus.tasks)
      .filter((task) => {
        const status = String(task.status || "").toLowerCase();
        return status === "assigned" || status === "in_progress" || status === "blocked" || status === "failed" || status === "completed";
      })
      .sort((a, b) => (b.updatedAt || b.completedAt || 0) - (a.updatedAt || a.completedAt || 0))
      .slice(0, 30)
      .forEach((task) => {
        const status = String(task.status || "").toLowerCase();
        const summary = task.resultContract && task.resultContract.summary
          ? task.resultContract.summary
          : (status === "completed" ? "Completed and ready for review." : `Now ${status}.`);
        upsertNotification({
          id: `task:${task.id}`,
          category: status === "completed" ? "delivery" : ((status === "blocked" || status === "failed") ? "attention" : "active"),
          title: task.title || `Task ${task.id || ""}`,
          body: summary,
          meta: [task.assignedRole, task.assignedWorkerId].filter(Boolean).join(" • "),
          actions: notificationActionsForTask(task.id || ""),
          desktopAlert: false,
          updatedAt: task.updatedAt || task.completedAt || task.createdAt,
        }, { incrementCount: false });
      });
    normalizeArray(state.reports)
      .slice(0, 20)
      .forEach((report) => {
        const reportUrl = report.reportUrl || (report.sessionKey ? `/api/v1/reports/${encodeURIComponent(report.sessionKey)}` : "");
        upsertNotification({
          id: `report:${report.sessionKey || report.id}`,
          category: "delivery",
          title: t("reports.deliveryTitle", { project: report.projectName || t("reports.projectFallback") }),
          body: compactText(report.requirementSummary || "A completion report is ready.", 160),
          meta: report.status || "completed",
          actions: [
            { kind: "open-report", label: "Open report", reportUrl },
            { kind: "switch-view", label: "Open reports", view: "reports" },
          ],
          desktopAlert: false,
          updatedAt: report.generatedAt,
        }, { incrementCount: false });
      });
  }

  function handleWsEvent(payload) {
    if (!payload || !payload.type) return;
    const data = payload.data || {};
    switch (payload.type) {
      case "controller:run":
        upsertControllerRunState(data);
        renderPlanning();
        break;
      case "clarification:requested":
        upsertClarificationState(data);
        upsertTaskDetailClarification(data);
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
        renderMissionSummary();
        renderClarifications();
        syncClarificationPrompt({ forceId: data.id });
        if (data.taskId === state.selectedTaskId && state.currentView === "tasks") {
          if (state.selectedTaskDetailTab === "clarifications") {
            renderTaskDetailContent();
          } else {
            renderTaskDetail(data.taskId).catch(() => {});
          }
        }
        break;
      case "clarification:answered":
        upsertClarificationState(data);
        upsertTaskDetailClarification(data);
        renderMissionSummary();
        renderClarifications();
        syncClarificationPrompt();
        if (data.taskId === state.selectedTaskId && state.currentView === "tasks") {
          if (state.selectedTaskDetailTab === "clarifications") {
            renderTaskDetailContent();
          } else {
            renderTaskDetail(data.taskId).catch(() => {});
          }
        }
        break;
      case "task:execution": {
        const taskId = data.taskId;
        const event = data.event || {};
        const current = normalizeArray(state.teamStatus.tasks).find((item) => item.id === taskId);
        if (current) {
          upsertTaskState({
            ...current,
            updatedAt: event.createdAt || Date.now(),
            progress: event.message || current.progress,
            execution: data.execution || current.execution,
          });
        }
        if (taskId === state.selectedTaskId && state.currentView === "tasks") {
          applyLiveTaskUpdate({ ...(current || {}), status: current?.status, assignedWorkerId: current?.assignedWorkerId, updatedAt: event.createdAt || Date.now(), id: taskId });
          appendLiveTaskExecution(event);
        }
        renderTasks({ skipDetail: true });
        break;
      }
      case "task:updated":
      case "task:completed":
      case "task:created": {
        const task = data || {};
        const status = String(task.status || "").toLowerCase();
        upsertTaskState(task);
        upsertNotification({
          id: `task:${task.id || task.taskId || Date.now()}`,
          category: status === "completed" ? "delivery" : ((status === "blocked" || status === "failed") ? "attention" : "active"),
          title: task.title || `Task ${task.id || ""}`,
          body: status === "completed" ? "Completed and ready for review." : `Now ${status || "updated"}.`,
          meta: [task.assignedRole, task.assignedWorkerId].filter(Boolean).join(" • "),
          actions: notificationActionsForTask(task.id || task.taskId || ""),
          desktopAlert: status === "completed" || status === "blocked" || status === "failed",
        });
        renderMissionSummary();
        renderTasks({ skipDetail: true });
        if (task.id === state.selectedTaskId) {
          if (isTaskTerminal(status)) {
            renderTaskDetail(task.id).catch(() => {});
            refreshWorkspaceTree().catch(() => {});
          } else {
            applyLiveTaskUpdate(task);
          }
        }
        break;
      }
      case "report:ready":
        upsertNotification({
          id: `report:${data.reportUrl || Date.now()}`,
          category: "delivery",
          title: t("reports.deliveryTitle", { project: data.projectName || t("reports.projectFallback") }),
          body: "A completion report is ready.",
          meta: data.status || "completed",
          actions: [
            { kind: "open-report", label: "Open report", reportUrl: data.reportUrl || "" },
            { kind: "switch-view", label: "Open reports", view: "reports" },
          ],
          desktopAlert: true,
        });
        refreshReports().catch(() => {});
        break;
      case "message:new":
        state.teamStatus.messages = [...normalizeArray(state.teamStatus.messages), data];
        appendTaskDetailMessage(data);
        if (data.taskId === state.selectedTaskId && state.currentView === "tasks" && state.selectedTaskDetailTab === "messages") {
          renderTaskDetailContent();
        }
        break;
      default:
        break;
    }
  }

  function disconnectWs() {
    clearReconnectTimer();
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
    setConnectionPill("connecting", t("connection.connecting"));
    ws.onopen = function () {
      clearReconnectTimer();
      state.reconnectAttempt = 0;
      setConnectionPill("connected", t("connection.connected"));
      state.connectionExpanded = false;
      setStatusLine(t("connection.connectedTo", { url: state.controllerUrl }));
      refreshAll(true).catch(() => {});
      renderChrome();
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
        state.ws = null;
        setConnectionPill("disconnected", t("connection.disconnected"));
        state.connectionExpanded = true;
        renderChrome();
        scheduleReconnect();
      }
    };
    ws.onerror = function () {
      if (state.ws === ws) {
        state.ws = null;
        setConnectionPill("disconnected", t("connection.disconnected"));
        state.connectionExpanded = true;
        renderChrome();
        scheduleReconnect();
      }
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
    state.isRefreshing = true;
    renderChrome();
    try {
      const [statusData, runsData, reportsData, workspaceTreeData] = await Promise.all([
        apiGet("/team/status"),
        apiGet("/controller/runs"),
        apiGet("/reports"),
        apiGet("/workspace/tree"),
      ]);
      state.teamStatus = {
        tasks: sortTasks(statusData.tasks),
        workers: normalizeArray(statusData.workers),
        clarifications: sortClarifications(statusData.clarifications),
        controllerRuns: normalizeArray(runsData.controllerRuns || statusData.controllerRuns).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
        messages: normalizeArray(statusData.messages),
        modelReadiness: statusData.modelReadiness || null,
        externalWorkerInstall: statusData.externalWorkerInstall || null,
      };
      state.reports = normalizeArray(reportsData.reports).sort((a, b) => (b.generatedAt || 0) - (a.generatedAt || 0));
      state.workspaceTree = normalizeArray(workspaceTreeData.entries);
    if (!state.selectedPlanningRunId && state.teamStatus.controllerRuns.length > 0) {
        state.selectedPlanningRunId = state.teamStatus.controllerRuns[0].id;
      }
      renderMissionSummary();
      renderPlanning();
      renderTasks();
      renderClarifications();
      renderReports();
      renderWorkspaceTree();
      renderRuntimeAlert();
      renderExternalWorkerInstallToggle();
      renderExternalWorkerInstallCard();
      updateNotificationsFromStatus();
      syncClarificationPrompt();
    } catch (error) {
      if (!silent) {
        setStatusLine(error instanceof Error ? error.message : "Failed to refresh controller state");
        setConnectionPill("disconnected", t("connection.disconnected"));
      }
      throw error;
    } finally {
      state.isRefreshing = false;
      renderChrome();
    }
  }

  async function connectController(url, opts) {
    clearReconnectTimer();
    state.reconnectAttempt = 0;
    state.isConnecting = true;
    renderChrome();
    try {
      state.controllerUrl = normalizeBaseUrl(url);
      if (!state.controllerUrl) throw new Error("Controller URL is required");
      $("#controller-url").value = state.controllerUrl;
      state.settings = await desktop.saveSettings({ ...(state.settings || {}), controllerUrl: state.controllerUrl });
      await refreshAll(false);
      state.unavailableScreenVisible = false;
      state.unavailableReason = "";
      connectWs();
      state.connectionExpanded = false;
      setStatusLine(t("connection.connectedTo", { url: state.controllerUrl }));
      renderChrome();
    } finally {
      state.isConnecting = false;
      renderChrome();
    }
  }

  async function submitComposer() {
    const input = $("#composer-input");
    const text = String(input && input.value || "").trim();
    if (!text || !state.controllerUrl) return;
    pushConversation('human', text);
    input.value = '';
    try {
      const data = await apiPost('/controller/intake', { message: text, sessionKey: state.sessionKey });
      pushConversation('controller', data.reply || 'Controller completed without a textual reply.');
      refreshAll(true).catch(() => {});
    } catch (error) {
      pushConversation('controller', error instanceof Error ? error.message : 'Failed to send requirement');
    }
  }

  async function answerClarification(id, sourceElement) {
    const item = normalizeArray(state.teamStatus.clarifications).find((entry) => entry.id === id);
    const schema = item && item.questionSchema ? item.questionSchema : null;
    const card = (sourceElement && sourceElement.closest(`[data-clarification-card="${CSS.escape(id)}"]`))
      || document.querySelector(`#clarification-modal [data-clarification-card="${CSS.escape(id)}"]`)
      || document.querySelector(`[data-clarification-card="${CSS.escape(id)}"]`)
      || document;
    const submitButton = sourceElement instanceof HTMLButtonElement ? sourceElement : null;
    const originalLabel = submitButton ? submitButton.textContent : "";
    const body = { answeredBy: 'human-desktop' };
    if (!schema || !schema.kind) {
      const textarea = document.querySelector(`[data-clarification-answer="${CSS.escape(id)}"]`);
      const answer = textarea ? textarea.value.trim() : '';
      if (!answer) return;
      body.answer = answer;
    } else if (schema.kind === 'single-select') {
      const selected = card.querySelector(`input[data-clarification-choice="${CSS.escape(id)}"]:checked`);
      if (!selected) return;
      if (selected.value === '__other__') {
        const other = card.querySelector(`[data-clarification-other="${CSS.escape(id)}"]`);
        body.answerValue = other ? other.value.trim() : '';
      } else {
        body.answerValue = selected.value;
      }
      const comment = card.querySelector(`[data-clarification-comment="${CSS.escape(id)}"]`);
      if (comment && comment.value.trim()) body.answerComment = comment.value.trim();
      if (!body.answerValue && !body.answerComment) return;
    } else if (schema.kind === 'multi-select') {
      const values = Array.from(card.querySelectorAll(`input[data-clarification-choice="${CSS.escape(id)}"]:checked`)).map((entry) => entry.value);
      const normalizedValues = values.filter((entry) => entry !== '__other__');
      if (values.includes('__other__')) {
        const other = card.querySelector(`[data-clarification-other="${CSS.escape(id)}"]`);
        if (other && other.value.trim()) normalizedValues.push(other.value.trim());
      }
      if (normalizedValues.length) body.answerValues = normalizedValues;
      const comment = card.querySelector(`[data-clarification-comment="${CSS.escape(id)}"]`);
      if (comment && comment.value.trim()) body.answerComment = comment.value.trim();
      if (!body.answerValues && !body.answerComment) return;
    } else if (schema.kind === 'number') {
      const numberInput = card.querySelector(`[data-clarification-number="${CSS.escape(id)}"]`);
      const raw = numberInput ? numberInput.value.trim() : '';
      if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) body.answerNumber = parsed;
      }
      const comment = card.querySelector(`[data-clarification-comment="${CSS.escape(id)}"]`);
      if (comment && comment.value.trim()) body.answerComment = comment.value.trim();
      if (body.answerNumber == null && !body.answerComment) return;
    } else {
      const textarea = document.querySelector(`[data-clarification-answer="${CSS.escape(id)}"]`);
      const answer = textarea ? textarea.value.trim() : '';
      if (!answer) return;
      body.answer = answer;
    }
    try {
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = 'Sending…';
      }
      setStatusLine('Submitting clarification answer…');
      const data = await apiPost(`/clarifications/${encodeURIComponent(id)}/answer`, body);
      if (data.clarification) {
        upsertClarificationState(data.clarification);
        upsertTaskDetailClarification(data.clarification);
      }
      if (data.task) {
        upsertTaskState(data.task);
        applyLiveTaskUpdate(data.task);
      }
      if (data.controllerRun) {
        upsertControllerRunState(data.controllerRun);
      }
      renderMissionSummary();
      renderPlanning();
      renderClarifications();
      renderTasks({ skipDetail: true });
      renderTaskDetailContent();
      syncClarificationPrompt();
      setStatusLine('Clarification answer submitted.');
      if (state.pendingRefreshTimer) {
        clearTimeout(state.pendingRefreshTimer);
      }
      state.pendingRefreshTimer = setTimeout(() => {
        state.pendingRefreshTimer = null;
        refreshAll(true).catch(() => {});
      }, 1200);
    } catch (error) {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel || 'Send answer';
      }
      setStatusLine(error instanceof Error ? error.message : 'Failed to answer clarification');
    }
  }

  async function connectSavedController() {
    state.settings = await desktop.getSettings();
    state.localSetupInfo = await desktop.getLocalSetupInfo();
    const defaultUrl = state.settings.controllerUrl || 'http://127.0.0.1:9527';
    $('#controller-url').value = defaultUrl;
    state.controllerUrl = defaultUrl;
    state.localSetupMode = 'controller-process';
    if (state.localSetupInfo && Array.isArray(state.localSetupInfo.modes)) {
      const preferredMode = state.localSetupInfo.modes.find((entry) => entry.recommended) || state.localSetupInfo.modes[0];
      if (preferredMode && preferredMode.id) {
        state.localSetupMode = preferredMode.id;
      }
    }
    renderChrome();
    renderUnavailableScreen();
    if (state.settings.controllerUrl) {
      try {
        await connectController(state.settings.controllerUrl, { skipConversation: true });
      } catch (error) {
        state.unavailableScreenVisible = true;
        state.unavailableReason = error instanceof Error ? error.message : 'Failed to connect';
        state.localSetupInfo = await desktop.getLocalSetupInfo();
        renderUnavailableScreen();
        setStatusLine(state.unavailableReason);
      }
    }
  }

  async function reconnectAfterLocalInstall() {
    const reconnectUrl = normalizeBaseUrl(
      state.controllerUrl
        || (state.settings && state.settings.controllerUrl)
        || 'http://127.0.0.1:9527',
    );
    $('#controller-url').value = reconnectUrl;
    state.controllerUrl = reconnectUrl;
    state.unavailableReason = t("bootstrap.connecting");
    renderUnavailableScreen();

    let lastError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await connectController(reconnectUrl, { skipConversation: true });
        state.unavailableScreenVisible = false;
        state.unavailableReason = "";
        renderUnavailableScreen();
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }
    }

    state.unavailableScreenVisible = true;
    state.unavailableReason = lastError instanceof Error ? lastError.message : t("bootstrap.failed");
    renderUnavailableScreen();
    setStatusLine('TeamClaw installed, but the local controller is not reachable yet.');
    return false;
  }

  $('#connect-btn').addEventListener('click', function () {
    state.unavailableScreenVisible = false;
    connectController($('#controller-url').value).catch((error) => {
      if (isLoopbackControllerUrl($('#controller-url').value)) {
        state.unavailableScreenVisible = true;
        state.unavailableReason = error instanceof Error ? error.message : 'Failed to connect';
        renderUnavailableScreen();
      }
      setStatusLine(error instanceof Error ? error.message : 'Failed to connect');
    });
  });
  $('#refresh-btn').addEventListener('click', function () {
    refreshAll(false).catch((error) => setStatusLine(error instanceof Error ? error.message : 'Refresh failed'));
    refreshWorkspaceTree().catch(() => {});
  });
  $('#language-toggle').addEventListener('click', function () {
    setLanguage(state.language === 'zh' ? 'en' : 'zh');
  });
  $('#compose-focus-btn').addEventListener('click', function () {
    activateView('mission');
    $('#composer-input').focus();
  });
  $('#composer-send').addEventListener('click', submitComposer);
  $('#connection-edit-btn').addEventListener('click', function () {
    state.connectionExpanded = !state.connectionExpanded;
    renderChrome();
  });
  $('#notice-toggle').addEventListener('click', function () {
    state.noticeDrawerOpen = !state.noticeDrawerOpen;
    renderChrome();
  });
  $('#notice-close').addEventListener('click', function () {
    state.noticeDrawerOpen = false;
    renderChrome();
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

    const workerInstallToggle = target.closest('#worker-install-toggle');
    if (workerInstallToggle) {
      state.externalWorkerInstallVisible = !state.externalWorkerInstallVisible;
      renderExternalWorkerInstallToggle();
      renderExternalWorkerInstallCard();
      return;
    }

    const bootstrapCopy = target.closest('[data-bootstrap-copy-install]');
    if (bootstrapCopy) {
      const hasOpenClaw = Boolean(state.localSetupInfo && state.localSetupInfo.hasOpenClaw);
      const mode = selectedLocalSetupMode();
      const command = hasOpenClaw
        ? (mode && mode.installCommand ? String(mode.installCommand) : "")
        : String((state.localSetupInfo && state.localSetupInfo.openClawInstallCommand) || "npm install -g openclaw@latest");
      copyText(command).then(() => {
        bootstrapCopy.textContent = t("bootstrap.copied");
        window.setTimeout(() => {
          bootstrapCopy.textContent = t("bootstrap.copyInstall");
        }, 1200);
      }).catch((error) => {
        setStatusLine(error instanceof Error ? error.message : 'Failed to copy command');
      });
      return;
    }

    const bootstrapInstall = target.closest('[data-bootstrap-install]');
    if (bootstrapInstall) {
      const hasOpenClaw = Boolean(state.localSetupInfo && state.localSetupInfo.hasOpenClaw);
      if (hasOpenClaw) {
        state.isInstallingLocal = true;
      } else {
        state.isInstallingOpenClaw = true;
      }
      state.unavailableReason = t("bootstrap.installing");
      renderUnavailableScreen();
      const installPromise = hasOpenClaw
        ? desktop.installLocalTeamClaw({ mode: state.localSetupMode })
        : desktop.installOpenClaw({ command: (state.localSetupInfo && state.localSetupInfo.openClawInstallCommand) || 'npm install -g openclaw@latest' });
      installPromise.then(async () => {
        state.isInstallingLocal = false;
        state.isInstallingOpenClaw = false;
        state.unavailableReason = "";
        state.localSetupInfo = await desktop.getLocalSetupInfo();
        if (hasOpenClaw) {
          await reconnectAfterLocalInstall();
          return;
        }
        renderUnavailableScreen();
      }).catch((error) => {
        state.isInstallingLocal = false;
        state.isInstallingOpenClaw = false;
        state.unavailableScreenVisible = true;
        state.unavailableReason = error instanceof Error ? error.message : 'Local install failed';
        renderUnavailableScreen();
        setStatusLine(state.unavailableReason);
      });
      return;
    }

    const bootstrapConnect = target.closest('[data-bootstrap-connect]');
    if (bootstrapConnect) {
      const urlInput = $('#bootstrap-controller-url');
      state.unavailableScreenVisible = false;
      connectController(urlInput && urlInput.value ? urlInput.value : '').catch((error) => {
        state.unavailableScreenVisible = true;
        state.unavailableReason = error instanceof Error ? error.message : 'Failed to connect';
        renderUnavailableScreen();
        setStatusLine(state.unavailableReason);
      });
      return;
    }

    const workerInstallCopy = target.closest('[data-worker-install-copy]');
    if (workerInstallCopy) {
      const command = buildExternalWorkerCommand(
        state.teamStatus.externalWorkerInstall,
        state.externalWorkerRole,
        state.externalWorkerDiscoveryMode,
      );
      copyText(command).then(() => {
        workerInstallCopy.textContent = t("worker.copied");
        window.setTimeout(() => {
          workerInstallCopy.textContent = t("worker.copy");
        }, 1200);
      }).catch((error) => {
        setStatusLine(error instanceof Error ? error.message : 'Failed to copy command');
      });
      return;
    }

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

    const planningGroupToggle = target.closest('[data-planning-group-toggle]');
    if (planningGroupToggle) {
      const groupKey = planningGroupToggle.getAttribute('data-planning-group-toggle') || '';
      if (groupKey) {
        state.planningGroupCollapsed[groupKey] = !state.planningGroupCollapsed[groupKey];
        renderPlanning();
      }
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
      state.selectedTaskDetailTab = 'overview';
      state.taskTimelineAutoFollow = true;
      state.taskDetailData = null;
      renderTasks();
      return;
    }

    const taskDetailTab = target.closest('[data-task-detail-tab]');
    if (taskDetailTab) {
      state.selectedTaskDetailTab = taskDetailTab.dataset.taskDetailTab || 'overview';
      if (state.selectedTaskDetailTab === 'timeline') {
        state.taskTimelineAutoFollow = true;
      }
      renderTaskDetailContent();
      return;
    }

    const submitClarification = target.closest('[data-clarification-submit]');
    if (submitClarification) {
      answerClarification(submitClarification.dataset.clarificationSubmit || '', submitClarification);
      return;
    }

    const openClarificationTask = target.closest('[data-clarification-open-task]');
    if (openClarificationTask) {
      state.clarificationPromptOpen = false;
      activateView('tasks');
      state.selectedTaskId = openClarificationTask.dataset.clarificationOpenTask || '';
      state.selectedTaskDetailTab = 'clarifications';
      state.taskDetailData = null;
      renderTasks();
      renderClarificationPrompt();
      return;
    }

    const openClarificationRun = target.closest('[data-clarification-open-run]');
    if (openClarificationRun) {
      state.clarificationPromptOpen = false;
      activateView('planning');
      state.selectedPlanningRunId = openClarificationRun.dataset.clarificationOpenRun || '';
      renderPlanning();
      renderClarificationPrompt();
      return;
    }

    const switchClarificationView = target.closest('[data-clarification-switch-view]');
    if (switchClarificationView) {
      state.clarificationPromptOpen = false;
      activateView(switchClarificationView.dataset.clarificationSwitchView || 'clarifications');
      renderClarificationPrompt();
      return;
    }

    const laterClarification = target.closest('[data-clarification-later]');
    if (laterClarification) {
      const clarificationId = laterClarification.dataset.clarificationLater || '';
      if (clarificationId && !state.dismissedClarificationIds.includes(clarificationId)) {
        state.dismissedClarificationIds.push(clarificationId);
      }
      state.clarificationPromptOpen = false;
      state.activeClarificationId = '';
      renderClarificationPrompt();
      return;
    }

    const modalDismiss = target.closest('[data-clarification-modal-dismiss]');
    if (modalDismiss) {
      const clarificationId = state.activeClarificationId;
      if (clarificationId && !state.dismissedClarificationIds.includes(clarificationId)) {
        state.dismissedClarificationIds.push(clarificationId);
      }
      state.clarificationPromptOpen = false;
      state.activeClarificationId = '';
      renderClarificationPrompt();
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
          state.selectedTaskDetailTab = 'overview';
          state.taskDetailData = null;
          renderTasks();
        }
        if (notice.dataset.runId) {
          state.selectedPlanningRunId = notice.dataset.runId;
          renderPlanning();
        }
        state.noticeDrawerOpen = false;
        renderChrome();
      }
      if (action === 'open-report' && notice.dataset.reportUrl) {
        desktop.openExternal(`${state.controllerUrl}${notice.dataset.reportUrl}`);
        state.noticeDrawerOpen = false;
        renderChrome();
      }
    }
  });

  document.addEventListener('change', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.matches('[data-worker-install-role]')) {
      state.externalWorkerRole = target.value || state.externalWorkerRole;
      renderExternalWorkerInstallCard();
      return;
    }
    if (target.matches('[data-bootstrap-mode]')) {
      state.localSetupMode = target.getAttribute('data-bootstrap-mode') || state.localSetupMode;
      renderUnavailableScreen();
      return;
    }
    if (target.matches('[data-worker-install-discovery]')) {
      state.externalWorkerDiscoveryMode = target.value === 'manual' ? 'manual' : 'mdns';
      renderExternalWorkerInstallCard();
    }
  });

  applyStaticTranslations();
  setStatusLine(t("connection.waiting"));
  setSummaryLine(t("connection.noSummary"));
  setConnectionPill("disconnected", t("connection.disconnected"));
  connectSavedController();
  renderConversation();
  activateView('mission');
  renderChrome();
})();
