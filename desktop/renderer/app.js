import { createT as i18nCreateT } from "./i18n.js";
(function () {
  "use strict";

  // Titleless window: platform drives titlebar insets (macOS traffic lights
  // vs Windows/Linux overlay controls).
  document.body.dataset.platform = window.teamclawDesktop?.platform || "";

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
    localSetupMode: "controller-manual",
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
    clarificationDrafts: {},
    // Resolved from the controller's role payload (teamStatus
    // .externalWorkerInstall.roles) when the install card first renders —
    // see renderExternalWorkerInstallCard. Kept empty until then so no role
    // id is hardcoded in the renderer.
    externalWorkerRole: '',
    externalWorkerDiscoveryMode: 'mdns',
    externalWorkerInstallVisible: false,
    language: loadLanguage(),
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

  const t = i18nCreateT(() => state.language);

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
    const wizardLanguageToggle = $("#wizard-language-toggle");
    if (wizardLanguageToggle) {
      wizardLanguageToggle.textContent = state.language === "zh" ? t("action.languageToggleEn") : t("action.languageToggleZh");
    }
    const texts = [
      [".connection-card h2", "connection.title"],
      ["#wizard-open-btn", "connection.setup"],
      ["#wizard-cancel-btn", "wizard.cancel"],
      [".connection-group .connection-group-label", "connection.prodGroup"],
      [".standalone-box .connection-group-label", "connection.privateGroup"],
      ["#standalone-start-btn", "connection.privateStart"],
      ["#standalone-stop-btn", "connection.privateStop"],
      [".standalone-box .bootstrap-note", "connection.privateNote"],
      [".nav-btn[data-view='mission'] .nav-label", "mission.title"],
      [".nav-btn[data-view='planning'] .nav-label", "tab.planning"],
      [".nav-btn[data-view='tasks'] .nav-label", "tab.tasks"],
      [".nav-btn[data-view='clarifications'] .nav-label", "tab.clarifications"],
      [".nav-btn[data-view='workspace'] .nav-label", "tab.workspace"],
      [".nav-btn[data-view='reports'] .nav-label", "tab.reports"],
      [".nav-btn[data-view='controller'] .nav-label", "tab.controller"],
      [".nav-btn[data-view='teamauto'] .nav-label", "tab.teamauto"],
      ["#teamauto-hint", "teamauto.hint"],
      ["#ta-repos-refresh", "teamauto.refreshRepos"],
      ["#ta-bind", "teamauto.bind"],
      ["[data-ta-tab='repos']", "teamauto.tabRepos"],
      ["[data-ta-tab='activity']", "teamauto.activity"],
      ["[data-ctl-tab='models']", "ctl.tab.models"],
      ["[data-ctl-tab='workspace']", "ctl.tab.workspace"],
      ["[data-ctl-tab='github']", "ctl.tab.github"],
      ["[data-ctl-tab='tunnel']", "ctl.tab.tunnel"],
      ["#ta-activity-title", "teamauto.activity"],
      ["#ctl-models-title", "ctl.models.title"],
      ["#ctl-models-hint", "ctl.models.hint"],
      ["#ctl-default-label", "ctl.models.default"],
      ["#ctl-models-save", "ctl.models.save"],
      ["#ctl-ws-title", "ctl.ws.title"],
      ["#ctl-ws-current-label", "ctl.ws.current"],
      ["#ctl-ws-hint", "ctl.ws.hint"],
      ["#ctl-ws-input-label", "ctl.ws.inputLabel"],
      ["#ctl-ws-apply", "ctl.ws.apply"],
      ["#ctl-gh-title", "ctl.gh.title"],
      ["#ctl-gh-current-label", "ctl.gh.current"],
      ["#ctl-gh-hint", "ctl.gh.hint"],
      ["#ctl-gh-login", "ctl.gh.login"],
      ["#ctl-gh-logout", "ctl.gh.logout"],
      ["#ctl-tunnel-title", "ctl.tunnel.title"],
      ["#ctl-tunnel-hint", "ctl.tunnel.hint"],
      ["#ctl-tunnel-share", "ctl.tunnel.share"],
      ["#ctl-tunnel-stop", "ctl.tunnel.stop"],
      ["#ctl-tunnel-install", "ctl.tunnel.install"],
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
      // Generic scan: any element carrying data-i18n translates itself.
      // (Wizard/bootstrap section adopted this; new static text should too.)
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        const k = el.getAttribute("data-i18n");
        const v = t(k);
        if (v && v !== k) el.textContent = v;
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        const k = el.getAttribute("data-i18n-placeholder");
        const v = t(k);
        if (v && v !== k) el.placeholder = v;
      });
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

  function canOpenProjectInFinder() {
    return isLoopbackControllerUrl(state.controllerUrl);
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

  // Worker display label: the full provisioned-developer-xxxx machine id
  // never renders raw. With a role, show a role chip + short id tail; the
  // full id stays available via title attr.
  function renderWorkerLabel(task, { chip = false } = {}) {
    const id = task?.assignedWorkerId || "";
    const role = task?.assignedRole || "";
    const short = id ? id.replace(/^provisioned-/, "").slice(0, 14) : "";
    const title = id || role;
    if (chip && role) return renderRoleChip(role);
    if (role) return `<span title="${escapeHtml(title)}">${escapeHtml(humanize(role))}${short ? " · " + escapeHtml(short) : ""}</span>`;
    if (short) return `<span title="${escapeHtml(title)}">${escapeHtml(short)}</span>`;
    return "";
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

  function splitMarkdownTableRow(line) {
    const trimmed = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((cell) => cell.trim());
  }

  function isMarkdownTableDivider(line) {
    const cells = splitMarkdownTableRow(line);
    if (!cells.length) return false;
    return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isMarkdownTableStart(lines, index) {
    const headerLine = String(lines[index] || "");
    const dividerLine = String(lines[index + 1] || "");
    if (!headerLine.includes("|") || !dividerLine.includes("|")) return false;
    const headerCells = splitMarkdownTableRow(headerLine);
    const dividerCells = splitMarkdownTableRow(dividerLine);
    if (headerCells.length < 2 || headerCells.length !== dividerCells.length) return false;
    return isMarkdownTableDivider(dividerLine);
  }

  function markdownTableAlignment(cell) {
    if (/^:-{3,}:$/.test(cell)) return "center";
    if (/^:-{3,}$/.test(cell)) return "left";
    if (/^-{3,}:$/.test(cell)) return "right";
    return "";
  }

  function renderMarkdownTable(lines, startIndex) {
    const headerCells = splitMarkdownTableRow(lines[startIndex]);
    const dividerCells = splitMarkdownTableRow(lines[startIndex + 1]);
    const alignments = dividerCells.map((cell) => markdownTableAlignment(cell));
    const bodyRows = [];
    let index = startIndex + 2;
    while (index < lines.length) {
      const line = String(lines[index] || "");
      if (!line.trim() || !line.includes("|")) break;
      const cells = splitMarkdownTableRow(line);
      if (cells.length !== headerCells.length) break;
      bodyRows.push(cells);
      index += 1;
    }
    const headerHtml = `<thead><tr>${headerCells.map((cell, idx) => `<th${alignments[idx] ? ` style="text-align:${alignments[idx]}"` : ""}>${renderMarkdownInline(cell)}</th>`).join("")}</tr></thead>`;
    const bodyHtml = bodyRows.length
      ? `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell, idx) => `<td${alignments[idx] ? ` style="text-align:${alignments[idx]}"` : ""}>${renderMarkdownInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
      : "";
    return {
      html: `<div class="markdown-table-wrap"><table>${headerHtml}${bodyHtml}</table></div>`,
      nextIndex: index - 1,
    };
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

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
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

      if (isMarkdownTableStart(lines, index)) {
        flushParagraph();
        flushList();
        flushQuote();
        const table = renderMarkdownTable(lines, index);
        html.push(table.html);
        index = table.nextIndex;
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
    let controlHtml = "";
    if (!schema || !schema.kind) {
      controlHtml = `<textarea data-clarification-answer="${escapeHtml(id)}" placeholder="${escapeHtml(t("clarification.answerPlaceholder"))}"></textarea>`;
    } else if (schema.kind === "single-select" || schema.kind === "multi-select") {
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

    const commentPlaceholder = schema && schema.kind === "text"
      ? "Additional context (optional)"
      : "Optional note or extra context";
    const commentField = schema && schema.kind === "text"
      ? ""
      : `<textarea data-clarification-comment="${escapeHtml(id)}" placeholder="${escapeHtml(commentPlaceholder)}"></textarea>`;
    return (
      `<div class="clarification-form" data-clarification-card="${escapeHtml(id)}">` +
      (schema && schema.description ? `<div class="clarification-body"><strong>Input guidance</strong>${renderMarkdownBlock(schema.description)}</div>` : "") +
      controlHtml +
      commentField +
      `<div class="inline-actions"><button class="inline-action" type="button" data-clarification-submit="${escapeHtml(id)}">Send answer</button></div>` +
      `</div>`
    );
  }

  function getClarificationPromptSignature(item) {
    if (!item || !item.id) return "";
    return JSON.stringify({
      id: item.id,
      updatedAt: item.updatedAt || item.createdAt || 0,
      status: item.status || "",
      question: item.question || "",
      blockingReason: item.blockingReason || "",
      context: item.context || "",
      schema: item.questionSchema || null,
      language: state.language,
    });
  }

  function rememberClarificationDraft(id, root) {
    if (!id || !(root instanceof Element || root instanceof Document)) return;
    const key = CSS.escape(id);
    const answer = root.querySelector(`[data-clarification-answer="${key}"]`);
    const comment = root.querySelector(`[data-clarification-comment="${key}"]`);
    const other = root.querySelector(`[data-clarification-other="${key}"]`);
    const number = root.querySelector(`[data-clarification-number="${key}"]`);
    const choices = Array.from(root.querySelectorAll(`input[data-clarification-choice="${key}"]:checked`)).map((input) => input.value);
    const draft = {
      answer: answer ? answer.value : "",
      comment: comment ? comment.value : "",
      other: other ? other.value : "",
      number: number ? number.value : "",
      choices,
    };
    if (draft.answer || draft.comment || draft.other || draft.number || draft.choices.length > 0) {
      state.clarificationDrafts[id] = draft;
    } else {
      delete state.clarificationDrafts[id];
    }
  }

  function restoreClarificationDraft(id, root) {
    if (!id || !(root instanceof Element || root instanceof Document)) return;
    const draft = state.clarificationDrafts[id];
    if (!draft) return;
    const key = CSS.escape(id);
    const answer = root.querySelector(`[data-clarification-answer="${key}"]`);
    const comment = root.querySelector(`[data-clarification-comment="${key}"]`);
    const other = root.querySelector(`[data-clarification-other="${key}"]`);
    const number = root.querySelector(`[data-clarification-number="${key}"]`);
    if (answer) answer.value = draft.answer || "";
    if (comment) comment.value = draft.comment || "";
    if (other) other.value = draft.other || "";
    if (number) number.value = draft.number || "";
    Array.from(root.querySelectorAll(`input[data-clarification-choice="${key}"]`)).forEach((input) => {
      input.checked = Array.isArray(draft.choices) && draft.choices.includes(input.value);
    });
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

  function pruneClarificationNotifications() {
    const pendingIds = new Set(
      normalizeArray(state.teamStatus.clarifications)
        .filter((item) => !item.answer)
        .map((item) => `clarification:${item.id}`),
    );
    state.notifications = state.notifications.filter((item) => {
      if (!item || typeof item.id !== 'string') return false;
      if (!item.id.startsWith('clarification:')) return true;
      return pendingIds.has(item.id);
    });
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

  async function apiGetOptional(path, fallbackValue) {
    const response = await fetch(controllerApi(path));
    if (response.status === 404) {
      return fallbackValue;
    }
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

  async function apiDelete(path) {
    const response = await fetch(controllerApi(path), {
      method: "DELETE",
    });
    if (!response.ok) {
      let message = `DELETE ${path} failed (${response.status})`;
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

  async function apiPut(path, body) {
    const response = await fetch(controllerApi(path), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      let message = `PUT ${path} failed (${response.status})`;
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

  // ---- Wizard (3 steps) ----
  // ---- LLM hard gate (user spec, 2026-11-07) ----
  // Private install: provider + model + apiKey are REQUIRED (endpoint
  // optional) before Install enables. Global mode with models already
  // configured: defaults to "use existing", user may switch to "configure".
  const LLM_DEFAULT_MODELS = {
    zai: "glm-4.6",
    anthropic: "claude-sonnet-4-5",
    openai: "gpt-6",
    openrouter: "anthropic/claude-sonnet-4.5",
    deepseek: "deepseek-chat",
    google: "gemini-3-pro",
  };
  // Where to get an API key per provider (user spec: clickable hint).
  const LLM_KEY_URLS = {
    zai: "https://z.ai/model-api",
    anthropic: "https://console.anthropic.com/settings/keys",
    openai: "https://platform.openai.com/api-keys",
    openrouter: "https://openrouter.ai/keys",
    deepseek: "https://platform.deepseek.com/api_keys",
    google: "https://aistudio.google.com/apikey",
  };
  let llmModelsFetchToken = 0;
  let llmModelsCache = [];
  function applyModelFilter(forceFull) {
    const select = document.getElementById("bootstrap-llm-model-select");
    const modelEl = document.getElementById("bootstrap-llm-model");
    if (!select || !modelEl || !llmModelsCache.length) return;
    // forceFull: after a fetch-filled smart default, show the FULL list for
    // browsing - filtering by the just-filled value collapses it to one
    // entry (user-reported). Only real typing filters.
    const q = forceFull ? "" : modelEl.value.trim().toLowerCase();
    const list = q ? llmModelsCache.filter((m) => m.toLowerCase().includes(q)) : llmModelsCache.slice();
    const current = modelEl.value.trim();
    const options = list.includes(current) || !current ? list : [current].concat(list);
    select.innerHTML = options.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("");
    select.hidden = false;
    modelEl.hidden = false; // stays visible as the filter/entry box
    if (current && options.includes(current)) select.value = current;
  }
  function updateLlmKeyHint() {
    const keyhint = document.getElementById("bootstrap-llm-keyhint");
    const prov = document.getElementById("bootstrap-llm-provider");
    if (!keyhint || !prov) return;
    const url = LLM_KEY_URLS[prov.value];
    // Only honor the "use existing" selection when the radio pair is
    // actually visible (global mode). In private mode the hidden radios
    // still exist in the DOM with `checked` on the first one - selecting it
    // here hid the key hint for everyone (user-found).
    const useRow = document.getElementById("bootstrap-llm-use-row");
    const useExisting = document.querySelector('input[name="llm-source"]:checked');
    const hideHint = Boolean(useRow && !useRow.hidden && useExisting && useExisting.value === "configured");
    if (!url || hideHint) { keyhint.hidden = true; keyhint.innerHTML = ""; return; }
    keyhint.hidden = false;
    keyhint.innerHTML = `${escapeHtml(t("wizard.keyHint"))} <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(prov.value)} → ${escapeHtml(url)}</a>`;
  }
  function scheduleLlmModelsFetch() {
    const prov = document.getElementById("bootstrap-llm-provider");
    const keyEl = document.getElementById("bootstrap-llm-apikey");
    const epEl = document.getElementById("bootstrap-llm-endpoint");
    if (!prov || !keyEl) return;
    const token = ++llmModelsFetchToken;
    const key = keyEl.value.trim();
    // OpenRouter's model list is public - fetch without a key too.
    if (prov.value !== "openrouter" && !key) return;
    window.teamclawDesktop.llmListModels({ provider: prov.value, endpoint: epEl ? epEl.value.trim() : "", apiKey: key })
      .then((res) => {
        if (token !== llmModelsFetchToken) return; // stale
        const select = document.getElementById("bootstrap-llm-model-select");
        const modelEl = document.getElementById("bootstrap-llm-model");
        if (!res || res.error || !Array.isArray(res.models) || !res.models.length || !select || !modelEl) return;
        llmModelsCache = res.models.slice();
        // Smart default: prefer the curated default if listed, else a free
        // entry on openrouter, else first. Only when the user hasn't chosen.
        if (!modelEl.dataset.userEdited) {
          const preferred = LLM_DEFAULT_MODELS[prov.value];
          const pick = res.models.find((m) => m === preferred)
            || res.models.find((m) => /free/i.test(m) && prov.value === "openrouter")
            || res.models[0];
          if (pick) modelEl.value = pick;
        }
        applyModelFilter(!modelEl.dataset.userEdited);
        updateLlmStep();
      })
      .catch(() => { /* manual input still works */ });
  }
  function llmMode() {
    const el = document.querySelector('input[name="bootstrap-mode"]:checked');
    return el ? el.getAttribute("data-bootstrap-mode") : "controller-manual";
  }
  function llmSource() {
    const el = document.querySelector('input[name="llm-source"]:checked');
    return el ? el.value : "custom";
  }
  function updateLlmStep() {
    const useRow = document.getElementById("bootstrap-llm-use-row");
    const fields = document.getElementById("bootstrap-llm-fields");
    const prov = document.getElementById("bootstrap-llm-provider");
    const modelEl = document.getElementById("bootstrap-llm-model");
    const keyEl = document.getElementById("bootstrap-llm-apikey");
    const hint = document.getElementById("bootstrap-llm-hint");
    const next2 = document.getElementById("wizard-next-2");
    if (!prov || !next2) return;
    const env = state.envDetect;
    const offerConfigured = llmMode() === "global" && env && env.llmConfigured;
    if (useRow) {
      useRow.hidden = !offerConfigured;
      const useRadio = document.querySelector('input[name="llm-source"][value="configured"]');
      if (offerConfigured && useRadio && !document.querySelector('input[name="llm-source"]:checked')) useRadio.checked = true;
      if (offerConfigured) {
        const lbl = document.getElementById("bootstrap-llm-use-label");
        const provs = (env.llmProviders || []).join(", ");
        if (lbl) lbl.textContent = provs ? `${t("wizard.llmUseConfigured")} (${provs})` : t("wizard.llmUseConfigured");
      }
    }
    const useExisting = offerConfigured && llmSource() === "configured";
    if (fields) fields.style.display = useExisting ? "none" : "";
    if (modelEl) {
      if (!modelEl.value.trim() && LLM_DEFAULT_MODELS[prov.value]) modelEl.value = LLM_DEFAULT_MODELS[prov.value];
      modelEl.placeholder = LLM_DEFAULT_MODELS[prov.value] || "model";
    }
    let reason = null;
    if (!useExisting) {
      if (!prov.value) reason = t("wizard.needProvider");
      else if (!keyEl || !keyEl.value.trim()) reason = t("wizard.needKey");
      else if (!modelEl || !modelEl.value.trim()) reason = t("wizard.needModel");
    }
    if (hint) { hint.hidden = !reason; hint.textContent = reason || ""; }
    next2.disabled = Boolean(reason);
  }
  function wizardGoStep(n) {
    document.querySelectorAll("[data-wizard-step]").forEach((el) => {
      el.hidden = el.getAttribute("data-wizard-step") !== String(n);
    });
    if (n === 2) updateLlmStep(); // hard gate: re-validate on every entry
    document.querySelectorAll("#wizard-steps .step-ind").forEach((el) => {
      const on = el.getAttribute("data-step-ind") === String(n);
      el.classList.toggle("active", on);
      el.classList.toggle("done", Number(el.getAttribute("data-step-ind")) < n);
    });
  }
  function bindWizardControls() {
    const next1 = document.getElementById("wizard-next-1");
    if (next1) next1.addEventListener("click", async () => {
      const checked = document.querySelector('input[name="bootstrap-mode"]:checked');
      const mode = checked ? checked.getAttribute("data-bootstrap-mode") : "controller-manual";
      if (mode === "remote") {
        const row = document.getElementById("bootstrap-remote-url-row");
        if (row) row.hidden = false;
        return; // remote: 停在步骤1 等用户填 URL 连接
      }
      if (mode === "global") {
        // Three cases (user spec):
        //  a) global already HAS teamclaw  -> just connect & remember
        //  b) global openclaw, no teamclaw -> install INTO it (backup first)
        //  c) no openclaw at all           -> full install, LLM step first
        const env = state.envDetect || (await desktop.envDetect().catch(() => null));
        const log = document.getElementById("bootstrap-log");
        if (env && env.openclaw && env.teamclawInGlobal) {
          wizardGoStep(3);
          if (log) log.textContent = "[global] TeamClaw already present in the global instance.\n";
          const url = env.globalControllerUrl || "http://127.0.0.1:9527";
          await desktop.instanceSet({ mode: "global", controllerUrl: url, llmConfigured: true }).catch(() => {});
          // Plugin registered does NOT mean the gateway is running (fresh
          // boot, killed process, no service manager on Windows). Probe
          // liveness; start the gateway ourselves when dead, then wait
          // bounded for the controller before connecting.
          const probe = async () => {
            try { const r = await fetch(url + "/api/v1/tunnel/status", { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
          };
          if (!(await probe())) {
            if (log) log.textContent += "[global] Global gateway not running - starting it...\n";
            const port = Number(new URL(url).port) || 9527;
            await desktop.instanceStartGlobal(port).catch(() => {});
            for (let i = 0; i < 45 && !(await probe()); i++) {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
          await connectController(url, { skipConversation: true }).catch(() => {});
          unveilShell();
          return;
        }
        if (env && env.openclaw && !env.teamclawInGlobal) {
          // LLM gate (user spec): installing INTO an existing global openclaw
          // still passes through step 2 - models already configured default
          // to "use existing"; the user may switch to "configure". Install
          // itself is triggered from step 2's Install button.
          wizardGoStep(2);
          return;
        }
        wizardGoStep(2); // case c: fresh global -> LLM step, then start-global
        return;
      }
      wizardGoStep(2); // private (default)
    });
    const next2 = document.getElementById("wizard-next-2");
    if (next2) next2.addEventListener("click", async () => {
      updateLlmStep();
      if (next2.disabled) return; // hard gate: never bypass via double-click
      const checked = document.querySelector('input[name="bootstrap-mode"]:checked');
      const mode = checked ? checked.getAttribute("data-bootstrap-mode") : "controller-manual";
      const env = state.envDetect;
      const useExisting = mode === "global" && env && env.llmConfigured && llmSource() === "configured";
      const provEl = document.getElementById("bootstrap-llm-provider");
      const keyEl = document.getElementById("bootstrap-llm-apikey");
      const epEl = document.getElementById("bootstrap-llm-endpoint");
      const modelEl = document.getElementById("bootstrap-llm-model");
      const llm = useExisting ? null : {
        provider: provEl.value,
        endpoint: epEl ? epEl.value.trim() : "",
        apiKey: keyEl ? keyEl.value.trim() : "",
        model: modelEl ? modelEl.value.trim() : "",
      };
      wizardGoStep(3);
      if (mode === "global") {
        const log = document.getElementById("bootstrap-log");
        const wizLine = (s) => { if (log) log.textContent += s + "\n"; };
        try {
          wizLine("[global] Starting global path...");
          if (llm) {
            wizLine(`[global] Writing ${llm.provider} config into the global OpenClaw...`);
            await desktop.llmWriteGlobal(llm);
          } else {
            wizLine("[global] Using the existing global model configuration.");
          }
          if (env && env.openclaw && !env.teamclawInGlobal) {
            const r = await desktop.instanceInstallIntoGlobal();
            await desktop.instanceSet({ mode: "global", controllerUrl: r.controllerUrl, llmConfigured: true }).catch(() => {});
            await connectController(r.controllerUrl, { skipConversation: true }).catch(() => {});
            unveilShell();
          } else {
            // Blank machine (user-found on Windows): bare start-global spawns
            // a binary that does not exist and the wizard sat on step 3
            // forever. installIntoGlobal self-provisions the runtime, installs
            // the plugin into the GLOBAL state, writes controller mode, and
            // only then starts the gateway - so it works with nothing present.
            wizLine("[global] No existing OpenClaw - running the full global install...");
            const r = await desktop.instanceInstallIntoGlobal();
            await desktop.instanceSet({ mode: "global", controllerUrl: r.controllerUrl, llmConfigured: true }).catch(() => {});
            await connectController(r.controllerUrl, { skipConversation: true }).catch(() => {});
            unveilShell();
          }
        } catch (e) {
          wizLine("[error] " + (e && e.message));
        }
        return;
      }
      const ib = document.getElementById("bootstrap-install-btn");
      // The step-3 install button stays hidden - it exists only as a
      // programmatic trigger; unhiding it left a stray "开始安装" visible
      // for the whole install (user-reported). A hidden button still
      // receives .click().
      if (ib) { ib.click(); }
    });
    document.querySelectorAll("[data-wizard-back]").forEach((b) => b.addEventListener("click", () => wizardGoStep(Number(b.getAttribute("data-wizard-back")) || 1)));
    const modes = document.querySelectorAll('input[name="bootstrap-mode"]');
    modes.forEach((m) => m.addEventListener("change", () => {
      const row = document.getElementById("bootstrap-remote-url-row");
      if (row) row.hidden = !m.checked || m.getAttribute("data-bootstrap-mode") !== "remote";
    }));
    const sel = document.getElementById("bootstrap-source");
    const gl = document.getElementById("bootstrap-artifact-url");
    if (sel && gl) sel.addEventListener("change", () => { gl.hidden = sel.value !== "artifact"; });
    // LLM hard gate: live validation while the user types/picks.
    ["bootstrap-llm-provider", "bootstrap-llm-model", "bootstrap-llm-apikey", "bootstrap-llm-endpoint"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", updateLlmStep);
    });
    // Provider UX (user spec): key-acquisition hint on provider change;
    // model list auto-refresh once a key exists (debounced). Mark manual
    // model edits so the fetch default never overwrites the user's choice.
    const provEl = document.getElementById("bootstrap-llm-provider");
    // Provider switch ALSO re-fetches (debounced): openrouter's list is
    // public, so switching to it must populate the picker without a manual
    // refresh click (user-found: "list gone until I hit refresh").
    if (provEl) provEl.addEventListener("change", () => {
      updateLlmKeyHint();
      clearTimeout(window.__llmFetchT);
      window.__llmFetchT = setTimeout(scheduleLlmModelsFetch, 400);
    });
    const keyElX = document.getElementById("bootstrap-llm-apikey");
    if (keyElX) keyElX.addEventListener("input", () => { updateLlmKeyHint(); clearTimeout(window.__llmFetchT); window.__llmFetchT = setTimeout(scheduleLlmModelsFetch, 700); });
    const modelElX = document.getElementById("bootstrap-llm-model");
    if (modelElX) modelElX.addEventListener("input", () => { modelElX.dataset.userEdited = modelElX.value.trim() ? "1" : ""; applyModelFilter(); });
    const modelSel = document.getElementById("bootstrap-llm-model-select");
    if (modelSel) modelSel.addEventListener("change", () => {
      // Pick from the list fills the entry box WITHOUT re-filtering, so the
      // list stays browsable after a selection.
      if (modelElX) { modelElX.value = modelSel.value; modelElX.dataset.userEdited = modelSel.value.trim() ? "1" : ""; }
      updateLlmStep();
    });
    const modelsRefresh = document.getElementById("bootstrap-llm-models-refresh");
    if (modelsRefresh) modelsRefresh.addEventListener("click", () => { modelElX && delete modelElX.dataset.userEdited; scheduleLlmModelsFetch(); });
    const epElX = document.getElementById("bootstrap-llm-endpoint");
    if (epElX) epElX.addEventListener("input", () => { clearTimeout(window.__llmFetchT); window.__llmFetchT = setTimeout(scheduleLlmModelsFetch, 700); });
    document.querySelectorAll('input[name="llm-source"]').forEach((r) => r.addEventListener("change", () => { updateLlmKeyHint(); updateLlmStep(); }));
  }

  function bootShell(msgKey) {
    const shell = $(".app-shell");
    const ov = $("#boot-screen");
    if (!ov || !shell || shell.dataset.bootShellReady === "1") return;
    const line = ov.querySelector(".boot-line");
    if (line) line.textContent = t(msgKey);
    ov.classList.remove("is-hidden");
    shell.classList.add("is-booting");
  }
  function unveilShell() {
    const shell = $(".app-shell");
    const ov = $("#boot-screen");
    if (!shell || !ov) return;
    ov.classList.add("is-hidden");
    shell.classList.remove("is-booting");
    shell.dataset.bootShellReady = "1";
  }

  function setConnectionPill(kind, text) {
    state.connectionState = kind;
    const el = $("#connection-pill");
    if (el) {
      // Icon-only when connected (click = change server); status word otherwise.
      if (kind === "connected") {
        el.textContent = "\u2713";
        el.title = t("connection.changeServer");
      } else {
        el.textContent = text;
        el.title = text;
      }
    }
    const summary = $("#connection-summary");
    if (summary) {
      // Connected: no URL/description shown (pill icon carries the state).
      summary.textContent = kind === "connected" ? "" : (state.controllerUrl || t("connection.notConnected"));
      summary.hidden = kind === "connected";
    }
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
  let controllerSettingsBound = false;

  function setControllerResult(id, text, isError) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("ctl-error", Boolean(isError));
  }

  function renderControllerSettings() {
    const connected = state.connectionState === "connected";
    document.querySelectorAll("#view-controller .ctl-actions button").forEach((btn) => {
      btn.disabled = !connected;
    });
    if (!connected) {
      const pathEl = document.getElementById("ctl-ws-path");
      if (pathEl) pathEl.textContent = "(" + t("ctl.notConnected") + ")";
      const badge = document.getElementById("ctl-ws-default");
      if (badge) badge.classList.add("is-hidden");
      const rolesEl = document.getElementById("ctl-roles");
      if (rolesEl) rolesEl.innerHTML = "";
      const defaultSelect = document.getElementById("ctl-default");
      if (defaultSelect) defaultSelect.innerHTML = "";
      setControllerResult("ctl-models-result", t("ctl.notConnected"), true);
      setControllerResult("ctl-ws-result", "", false);
      return;
    }
    setControllerResult("ctl-models-result", "", false);
    setControllerResult("ctl-ws-result", "", false);
    bindControllerSettings();
    bindGithubAuthControls();
    renderControllerWorkspaceCard();
    renderControllerModelsCard();
    renderGithubAuthCard();
  }

  async function renderGithubAuthCard() {
    const accountEl = document.getElementById("ctl-gh-account");
    const loginBtn = document.getElementById("ctl-gh-login");
    const logoutBtn = document.getElementById("ctl-gh-logout");
    if (!accountEl || !loginBtn || !logoutBtn) return;
    let status;
    try {
      status = await apiGet("/auth/github/status");
    } catch {
      accountEl.textContent = "-";
      return;
    }
    if (status.authenticated && status.account) {
      const when = status.expiresAt
        ? " - " + t("ctl.gh.validUntil") + " " + formatGithubAuthTime(status.expiresAt)
        : "";
      accountEl.textContent = "@" + status.account.login + when;
      loginBtn.hidden = true;
      logoutBtn.hidden = false;
    } else {
      accountEl.textContent = t("ctl.gh.signedOut");
      loginBtn.hidden = false;
      logoutBtn.hidden = true;
    }
    setControllerResult("ctl-gh-result", "", false);
    renderGithubCorner(status);
  }

  function renderGithubCorner(status) {
    const loginBtn = document.getElementById("gh-corner-login");
    const userBtn = document.getElementById("gh-corner-user");
    if (!loginBtn || !userBtn) return;
    if (status && status.authenticated && status.account) {
      const nameEl = document.getElementById("gh-corner-name");
      if (nameEl) nameEl.textContent = "@" + status.account.login;
      const av = document.getElementById("gh-corner-avatar");
      if (av) {
        if (status.account.avatarUrl) {
          av.src = status.account.avatarUrl;
          av.classList.remove("is-hidden");
        } else {
          av.classList.add("is-hidden");
        }
      }
      userBtn.hidden = false;
      loginBtn.hidden = true;
    } else {
      userBtn.hidden = true;
      loginBtn.textContent = t("ctl.gh.login");
      loginBtn.hidden = false;
    }
  }

  function openGithubLoginPage() {
    const base = state.controllerUrl || "http://127.0.0.1:9527";
    const url = base.replace(/\/+$/, "") + "/ui/auth/github";
    if (desktop && typeof desktop.openExternal === "function") {
      desktop.openExternal(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  let githubCornerTimer = null;
  function setupGithubCorner() {
    const loginBtn = document.getElementById("gh-corner-login");
    if (loginBtn && !loginBtn.dataset.bound) {
      loginBtn.dataset.bound = "true";
      loginBtn.addEventListener("click", () => {
        openGithubLoginPage();
        pollGithubAuthStatus(360);
      });
    }
    const userBtn = document.getElementById("gh-corner-user");
    if (userBtn && !userBtn.dataset.bound) {
      userBtn.dataset.bound = "true";
      userBtn.addEventListener("click", async () => {
        try {
          await apiPost("/auth/github/logout", {});
        } catch { /* refresh regardless */ }
        try {
          renderGithubCorner(await apiGet("/auth/github/status"));
        } catch { /* ignore */ }
      });
    }
    if (!githubCornerTimer) {
      githubCornerTimer = setInterval(() => {
        if (state.connectionState !== "connected") return;
        apiGet("/auth/github/status").then(renderGithubCorner).catch(() => {});
      }, 10000);
    }
  }

  function formatGithubAuthTime(epochMs) {
    const d = new Date(epochMs);
    return d.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  let githubAuthPollTimer = null;
  function pollGithubAuthStatus(attemptsLeft) {
    if (githubAuthPollTimer) clearTimeout(githubAuthPollTimer);
    if (attemptsLeft <= 0) return;
    githubAuthPollTimer = setTimeout(async () => {
      try {
        const status = await apiGet("/auth/github/status");
        if (status && status.authenticated) {
          renderGithubAuthCard();
        } else {
          pollGithubAuthStatus(attemptsLeft - 1);
        }
      } catch {
        pollGithubAuthStatus(attemptsLeft - 1);
      }
    }, 2500);
  }

  let teamAutoBtnBound = false;
  let teamAutoCandidates = [];
  let teamAutoCandidatesLoaded = false;

  async function apiPatch(path, body) {
    const response = await fetch(controllerApi(path), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      let message = `PATCH ${path} failed (${response.status})`;
      try {
        const data = await response.json();
        message = data.error || data.message || message;
      } catch { /* ignore */ }
      throw new Error(message);
    }
    return response.json();
  }

  function taBindOverlay() {
    return document.getElementById("ta-bind-overlay");
  }

  function taSetBindStage(stage, note, isError) {
    const overlay = taBindOverlay();
    if (!overlay) { return; }
    overlay.querySelectorAll(".ta-bind-steps li").forEach((li) => {
      const n = parseInt(li.getAttribute("data-stage") || "0", 10);
      li.classList.toggle("done", !isError && n < stage);
      li.classList.toggle("active", !isError && n === stage);
      li.classList.toggle("error", !!isError && n === stage);
    });
    const noteEl = document.getElementById("ta-bind-overlay-note");
    if (noteEl) { noteEl.textContent = note || ""; noteEl.className = "ta-bind-note" + (isError ? " err" : ""); }
  }

  function taCloseBindOverlay(delayMs) {
    const overlay = taBindOverlay();
    if (!overlay) { return; }
    setTimeout(() => {
      overlay.classList.add("is-hidden");
      const closeBtn = document.getElementById("ta-bind-overlay-close");
      if (closeBtn) { closeBtn.classList.add("is-hidden"); }
    }, delayMs || 0);
  }

  // Bind is async on the server: POST returns fast, then clone + norms run in
  // the background. Drive the stage overlay by polling the repo provision state.
  async function taRunBindWithOverlay(repo, schedule) {
    const overlay = taBindOverlay();
    const closeBtn = document.getElementById("ta-bind-overlay-close");
    const titleEl = document.getElementById("ta-bind-overlay-title");
    if (!overlay) {
      // Overlay markup missing (older window) - fall back to plain wait.
      try { await apiPost("/teamauto/repos", { repo, schedule }); return true; }
      catch (err) { taMsg(err instanceof Error ? err.message : String(err), false); return false; }
    }
    if (titleEl) { titleEl.textContent = `${t("teamauto.bind")}: ${repo}`; }
    closeBtn && closeBtn.classList.add("is-hidden");
    overlay.classList.remove("is-hidden");
    taSetBindStage(1, "");
    let bound = false;
    try {
      await apiPost("/teamauto/repos", { repo, schedule });
      bound = true;
    } catch (err) {
      taSetBindStage(1, err instanceof Error ? err.message : String(err), true);
      closeBtn && closeBtn.classList.remove("is-hidden");
      return false;
    }
    // Poll provision state until ready/failed (max ~5min).
    const deadline = Date.now() + 300000;
    let lastStage = 1;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      let provision = null;
      try {
        const data = await apiGet("/teamauto/repos");
        const list = (data && data.repos) || [];
        const hit = list.find((r) => r && r.id === repo);
        provision = (hit && hit.provision) || { status: hit ? "ready" : "missing" };
      } catch { /* transient poll failure - keep waiting */ }
      if (!provision) { continue; }
      if (provision.status === "failed") {
        taSetBindStage(lastStage, `${t("teamauto.bindFailed")}: ${provision.message || ""}`, true);
        closeBtn && closeBtn.classList.remove("is-hidden");
        closeBtn && closeBtn.addEventListener("click", () => taCloseBindOverlay(0), { once: true });
        return false;
      }
      const stage = /norm/i.test(provision.message || "") ? 3 : 2;
      lastStage = Math.max(lastStage, stage);
      taSetBindStage(stage, provision.message || "");
      if (provision.status === "ready") {
        taSetBindStage(4, t("teamauto.bindReady"));
        taCloseBindOverlay(900);
        return true;
      }
    }
    taSetBindStage(lastStage, "timeout", true);
    closeBtn && closeBtn.classList.remove("is-hidden");
    return false;
  }

  function taMsg(text, ok) {
    const el = document.getElementById("ta-bind-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "teamauto-msg" + (text ? (ok ? " ok" : " err") : "");
  }

  async function loadTeamAutoCandidates(force) {
    if (teamAutoCandidatesLoaded && !force) return;
    const select = document.getElementById("ta-repo-select");
    if (!select) return;
    if (state.connectionState !== "connected") {
      select.innerHTML = `<option>${t("ctl.notConnected")}</option>`;
      return;
    }
    select.innerHTML = `<option>${t("teamauto.loadingRepos")}</option>`;
    try {
      const data = await apiGet("/teamauto/repo-candidates");
      teamAutoCandidates = (data && data.candidates) || [];
      teamAutoCandidatesLoaded = true;
      select.innerHTML = teamAutoCandidates.length
        ? teamAutoCandidates.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.id + (r.private ? " (private)" : ""))}</option>`).join("")
        : `<option value="">${t("teamauto.noCandidates")}</option>`;
    } catch (err) {
      select.innerHTML = `<option value="">${t("teamauto.noCandidates")}</option>`;
      taMsg(err instanceof Error ? err.message : String(err), false);
    }
  }

  function renderTeamAutoRepos(status) {
    const wrap = document.getElementById("ta-repos");
    if (!wrap) return;
    const repos = (status && status.repos) || [];
    if (!repos.length) {
      wrap.innerHTML = `<div class="empty-state">${t("teamauto.empty")}</div>`;
      return;
    }
    wrap.innerHTML = repos.map((r) => {
      let badge;
      if (!r.enabled) {
        badge = `<span class="teamauto-badge">${t("teamauto.disabled")}</span>`;
      } else if (r.provision && r.provision.status === "provisioning") {
        badge = `<span class="teamauto-badge" title="${escapeHtml(r.provision.message || "")}">${t("teamauto.provisioning")}</span>`;
      } else if (r.provision && r.provision.status === "failed") {
        badge = `<span class="teamauto-badge warn" title="${escapeHtml(r.provision.message || "")}">${t("teamauto.provisionFailed")}</span>`;
      } else if (r.pausedReason) {
        badge = `<span class="teamauto-badge warn" title="${escapeHtml(r.pausedReason)}">${t("teamauto.paused")}</span>`;
      } else {
        badge = `<span class="teamauto-badge on">${t("teamauto.active")}</span>`;
      }
      const when = r.lastSweepAt ? new Date(r.lastSweepAt).toLocaleString() : "-";
      const norms = r.norms ? escapeHtml(r.norms.commitStyle) : "...";
      const fr = r.policy.actions.fullReview;
      return `<div class="teamauto-card" data-repo="${escapeHtml(r.id)}">` +
        `<div class="teamauto-card-head"><span class="teamauto-repo-name">${escapeHtml(r.id)}</span>${badge}</div>` +
        `<div class="teamauto-meta">${t("teamauto.schedule")}: <code>${escapeHtml(r.schedule)}</code> | ${t("teamauto.lastSweep")}: ${escapeHtml(when)}` +
        (r.lastSweepSummary ? ` | ${escapeHtml(r.lastSweepSummary)}` : "") +
        `<br>${t("teamauto.norms")}: ${norms}` +
        (r.pausedReason ? `<br><span class="teamauto-warn-text">${escapeHtml(r.pausedReason)}</span>` : "") + "</div>" +
        `<div class="teamauto-config-row">` +
        `<label>${t("teamauto.schedule")} <input data-cfg="schedule" type="text" value="${escapeHtml(r.schedule)}" spellcheck="false"></label>` +
        `<label>${t("teamauto.maxPerSweep")} <input data-cfg="maxTasksPerSweep" type="number" min="1" max="20" value="${r.policy.maxTasksPerSweep}"></label>` +
        `<label>${t("teamauto.fullReview")} <select data-cfg="fullReview">` +
        ["off", "weekly", "daily"].map((v) => `<option value="${v}"${fr === v ? " selected" : ""}>${v}</option>`).join("") + "</select></label>" +
        `<label>${t("teamauto.takeOwnership")} <select data-cfg="takeOwnership">` +
        `<option value="true"${r.policy.actions.takeOwnership ? " selected" : ""}>on</option>` +
        `<option value="false"${!r.policy.actions.takeOwnership ? " selected" : ""}>off</option></select></label>` +
        `<button class="btn btn-small" data-act="save">${t("teamauto.save")}</button>` +
        "</div>" +
        `<div class="teamauto-actions">` +
        `<button class="btn btn-small" data-act="sweep">${t("teamauto.sweep")}</button>` +
        `<button class="btn btn-small" data-act="toggle">${t(r.enabled ? "teamauto.disable" : "teamauto.enable")}</button>` +
        `<button class="btn btn-small btn-danger" data-act="unbind">${t("teamauto.unbind")}</button>` +
        "</div></div>";
    }).join("");
  }

  let teamAutoBusy = false;
  function renderTeamAutoActivity(activity) {
    const wrap = document.getElementById("ta-activity");
    if (!wrap) return;
    const list = activity || [];
    if (!list.length) {
      wrap.innerHTML = `<div class="empty-state">${t("teamauto.activityEmpty")}</div>`;
      return;
    }
    wrap.innerHTML = list.slice(0, 30).map((e) => {
      const when = new Date(e.at || 0).toLocaleString();
      return `<div class="teamauto-activity-item">`
        + `<span class="teamauto-activity-kind k-${escapeHtml(String(e.kind || "sweep"))}">${escapeHtml(String(e.kind || ""))}</span>`
        + `<span class="teamauto-activity-text"><b>${escapeHtml(String(e.repoId || ""))}</b> ${escapeHtml(String(e.text || ""))}</span>`
        + `<span class="teamauto-activity-time">${escapeHtml(when)}</span>`
        + `</div>`;
    }).join("");
  }

  async function renderTeamAuto() {
    if (state.connectionState !== "connected") {
      const wrap = document.getElementById("ta-repos");
      if (wrap) wrap.innerHTML = `<div class="empty-state">${t("ctl.notConnected")}</div>`;
      return;
    }
    if (teamAutoBusy) return;
    teamAutoBusy = true;
    void loadTeamAutoCandidates(false);
    try {
      renderTeamAutoRepos(await apiGet("/teamauto/repos"));
    } catch { /* scheduler offline */ }
    try {
      const data = await apiGet("/teamauto/activity");
      renderTeamAutoActivity((data && data.activity) || []);
    } catch { /* activity is best-effort */ }
    finally { teamAutoBusy = false; }
  }

  function bindTeamAutoControls() {
    if (teamAutoBtnBound) return;
    teamAutoBtnBound = true;
    // Sub-tabs (Repositories | Activity): plain class toggling; both panes
    // keep rendering so switching tabs never needs a refetch.
    document.querySelectorAll(".ta-tab[data-ta-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-ta-tab");
        document.querySelectorAll(".ta-tab[data-ta-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".ta-tabpane[data-ta-pane]").forEach((p) => p.classList.toggle("active", p.getAttribute("data-ta-pane") === tab));
      });
    });
    // Controller settings tabs (models | workspace | github | tunnel): same
    // toggle semantics; every pane keeps rendering from its own pollers.
    document.querySelectorAll(".ta-tab[data-ctl-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-ctl-tab");
        document.querySelectorAll(".ta-tab[data-ctl-tab]").forEach((b) => b.classList.toggle("active", b === btn));
        document.querySelectorAll(".ta-tabpane[data-ctl-pane]").forEach((p) => p.classList.toggle("active", p.getAttribute("data-ctl-pane") === tab));
      });
    });
    const bindBtn = document.getElementById("ta-bind");
    if (bindBtn) {
      bindBtn.addEventListener("click", async () => {
        const select = document.getElementById("ta-repo-select");
        const repo = select ? select.value.trim() : "";
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          taMsg(t("teamauto.needRepo"), false);
          return;
        }
        const schedEl = document.getElementById("ta-schedule");
        bindBtn.disabled = true;
        const done = await taRunBindWithOverlay(repo, schedEl && schedEl.value.trim() ? schedEl.value.trim() : undefined);
        bindBtn.disabled = false;
        if (done) { taMsg(`${repo} -> ${t("teamauto.active")}`, true); renderTeamAuto(); }
      });
    }
    const refreshBtn = document.getElementById("ta-repos-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        await loadTeamAutoCandidates(true);
        refreshBtn.disabled = false;
      });
    }
    const wrap = document.getElementById("ta-repos");
    if (wrap) {
      wrap.addEventListener("click", async (event) => {
        const btn = event.target;
        if (!(btn instanceof Element) || btn.tagName !== "BUTTON") return;
        const card = btn.closest("[data-repo]");
        if (!card) return;
        const repoId = card.getAttribute("data-repo") || "";
        const encoded = encodeURIComponent(repoId);
        const act = btn.getAttribute("data-act");
        btn.disabled = true;
        try {
          if (act === "sweep") {
            const body = await apiPost(`/teamauto/repos/${encoded}/sweep`, {});
            taMsg((body && body.summary) || "sweep done", true);
          } else if (act === "unbind") {
            if (!window.confirm(t("teamauto.confirmUnbind"))) { btn.disabled = false; return; }
            await apiDelete(`/teamauto/repos/${encoded}`);
          } else if (act === "toggle") {
            const enabling = btn.textContent.trim() !== t("teamauto.disable");
            await apiPatch(`/teamauto/repos/${encoded}`, { enabled: enabling });
          } else if (act === "save") {
            const payload = {};
            card.querySelectorAll("[data-cfg]").forEach((el) => {
              const key = el.getAttribute("data-cfg");
              if (key === "schedule") payload.schedule = el.value.trim();
              if (key === "maxTasksPerSweep") payload.maxTasksPerSweep = Number(el.value) || undefined;
              if (key === "fullReview") payload.fullReview = el.value;
              if (key === "takeOwnership") payload.takeOwnership = el.value === "true";
            });
            await apiPatch(`/teamauto/repos/${encoded}`, payload);
            taMsg(t("teamauto.saved"), true);
          }
        } catch (err) {
          taMsg(err instanceof Error ? err.message : String(err), false);
        } finally {
          renderTeamAuto();
        }
      });
    }
    setInterval(() => {
      if (state.currentView === "teamauto" && state.connectionState === "connected") renderTeamAuto();
    }, 10000);
  }

  function bindGithubAuthControls() {
    const loginBtn = document.getElementById("ctl-gh-login");
    const logoutBtn = document.getElementById("ctl-gh-logout");
    if (loginBtn && !loginBtn.dataset.bound) {
      loginBtn.dataset.bound = "true";
      loginBtn.addEventListener("click", async () => {
        loginBtn.disabled = true;
        try {
          openGithubLoginPage();
          setControllerResult("ctl-gh-result", t("ctl.gh.pageOpened"), false);
          pollGithubAuthStatus(360);
        } catch (err) {
          setControllerResult("ctl-gh-result", err instanceof Error ? err.message : t("ctl.gh.failed"), true);
        } finally {
          loginBtn.disabled = false;
        }
      });
    }
    if (logoutBtn && !logoutBtn.dataset.bound) {
      logoutBtn.dataset.bound = "true";
      logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        try {
          await apiPost("/auth/github/logout", {});
          setControllerResult("ctl-gh-result", t("ctl.gh.loggedOut"), false);
        } catch (err) {
          setControllerResult("ctl-gh-result", err instanceof Error ? err.message : t("ctl.gh.failed"), true);
        } finally {
          logoutBtn.disabled = false;
          renderGithubAuthCard();
        }
      });
    }
  }

  async function renderControllerWorkspaceCard() {
    const pathEl = document.getElementById("ctl-ws-path");
    const badge = document.getElementById("ctl-ws-default");
    if (!pathEl || !badge) return;
    try {
      const data = await apiGet("/workspace/status");
      pathEl.textContent = data.workspaceDir || "(unknown)";
      badge.classList.toggle("is-hidden", data.isDefault !== true);
    } catch (err) {
      pathEl.textContent = "(unavailable)";
      badge.classList.add("is-hidden");
      void err;
    }
  }

  async function renderControllerModelsCard() {
    const defaultSelect = document.getElementById("ctl-default");
    const rolesEl = document.getElementById("ctl-roles");
    if (!defaultSelect || !rolesEl) return;
    let catalog;
    try {
      catalog = await apiGet("/models/config");
      setControllerResult("ctl-models-result", "", false);
    } catch (err) {
      setControllerResult("ctl-models-result", err instanceof Error ? err.message : t("ctl.models.failed"), true);
      return;
    }
    const options = [];
    (catalog.providers || []).forEach((provider) => {
      (provider.models || []).forEach((modelId) => {
        options.push({ value: provider.id + "/" + modelId, label: provider.id + " / " + modelId });
      });
    });
    if (catalog.defaultModel && !options.some((opt) => opt.value === catalog.defaultModel)) {
      options.unshift({ value: catalog.defaultModel, label: catalog.defaultModel + " (current)" });
    }
    defaultSelect.innerHTML = options
      .map((opt) => '<option value="' + escapeHtml(opt.value) + '">' + escapeHtml(opt.label) + "</option>")
      .join("");
    defaultSelect.value = catalog.defaultModel || (options.length ? options[0].value : "");
    const overrides = catalog.roleModelOverrides || {};
    rolesEl.innerHTML = (catalog.roles || [])
      .map((role) => {
        const current = overrides[role.id] || "";
        return '<label class="ctl-field"><span>' + escapeHtml(role.label) + '</span>'
          + '<select data-ctl-role="' + escapeHtml(role.id) + '">'
          + '<option value="">' + escapeHtml(t("ctl.models.useDefault")) + "</option>"
          + options.map((opt) => '<option value="' + escapeHtml(opt.value) + '"' + (current === opt.value ? " selected" : "") + '>' + escapeHtml(opt.label) + "</option>").join("")
          + "</select></label>";
      })
      .join("");
  }

  function bindControllerSettings() {
    if (controllerSettingsBound) return;
    controllerSettingsBound = true;
    const saveBtn = document.getElementById("ctl-models-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        const defaultSelect = document.getElementById("ctl-default");
        const payload = { roleModelOverrides: {} };
        if (defaultSelect && defaultSelect.value) payload.defaultModel = defaultSelect.value;
        document.querySelectorAll("[data-ctl-role]").forEach((sel) => {
          const role = sel.getAttribute("data-ctl-role");
          if (role && sel.value) payload.roleModelOverrides[role] = sel.value;
        });
        saveBtn.disabled = true;
        try {
          await apiPut("/models/config", payload);
          setControllerResult("ctl-models-result", t("ctl.models.saved"), false);
        } catch (err) {
          setControllerResult("ctl-models-result", err instanceof Error ? err.message : t("ctl.models.failed"), true);
        } finally {
          saveBtn.disabled = false;
        }
      });
    }
    const applyBtn = document.getElementById("ctl-ws-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", async () => {
        const input = document.getElementById("ctl-ws-input");
        const value = input ? input.value.trim() : "";
        if (!value || (!value.startsWith("/") && !value.startsWith("~/"))) {
          setControllerResult("ctl-ws-result", t("ctl.ws.needAbsolute"), true);
          return;
        }
        applyBtn.disabled = true;
        try {
          await apiPost("/workspace/change-dir", { workspaceDir: value });
          setControllerResult("ctl-ws-result", t("ctl.ws.saved"), false);
          renderControllerWorkspaceCard();
        } catch (err) {
          setControllerResult("ctl-ws-result", err instanceof Error ? err.message : t("ctl.ws.failed"), true);
        } finally {
          applyBtn.disabled = false;
        }
      });
    }
  }

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
    // v3.1 S1: overlay is the 3-step wizard; keep busy/visibility semantics only.
    const ov = $("#bootstrap-overlay");
    if (ov) ov.classList.toggle("hidden", !state.unavailableScreenVisible && state.connectionState === "connected");
    // Fresh-machine path: when the wizard must show (no instance record and
    // no ready runtime), lift the boot gate - otherwise "Connecting..." sits
    // on top of the wizard forever (true-sandbox launch hung exactly here;
    // fake HOME sandboxes masked it by adopting the real machine's state).
    if (state.unavailableScreenVisible && state.connectionState !== "connected") unveilShell();
    const busy = Boolean(state.localSetupInfo && state.localSetupInfo.hasOpenClaw ? state.isInstallingLocal : state.isInstallingOpenClaw);
    const log = $("#bootstrap-log");
    if (log) log.parentElement && (log.parentElement.hidden = false);
    void busy;
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
      // Prefer the payload-advertised default (the registry DEFAULT_ROLE on
      // the controller) when it names a real registry entry.
      const payloadDefaultRole = typeof info.defaultRole === 'string' ? info.defaultRole : '';
      const validDefault = payloadDefaultRole && roles.some((role) => role.id === payloadDefaultRole);
      state.externalWorkerRole = validDefault ? payloadDefaultRole : roles[0].id;
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
    const pillEl = $("#connection-pill");
    const connectBtn = $("#connect-btn");
    const refreshBtn = $("#refresh-btn");
    const drawer = $("#notice-drawer");
    const connected = state.connectionState === "connected";
    const controllerNavBtn = document.querySelector(".nav-btn[data-view='controller']");
    if (controllerNavBtn) controllerNavBtn.disabled = !connected;
    const condensed = connected && !state.connectionExpanded;
    if (card) card.classList.toggle("is-condensed", condensed);
    if (body) body.style.display = condensed ? "none" : "";
    if (pillEl) {
      pillEl.className = `pill pill-${state.connectionState}`;
      pillEl.classList.toggle("is-clickable", connected);
    }
    if (summary) {
      summary.textContent = connected
        ? ""
        : (state.controllerUrl || t("connection.notConnected"));
      summary.hidden = connected;
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
    renderUnavailableScreen();
  }

  function activateView(view) {
    const validViews = new Set(["mission", "planning", "tasks", "clarifications", "workspace", "reports", "teamauto", "controller"]);
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
    } else if (nextView === "teamauto") {
      renderTeamAuto();
    } else if (nextView === "controller") {
      renderControllerSettings();
    } else {
      renderMissionSummary();
      renderConversation();
    }

    renderChrome();
  }

  function normalizeArray(input) {
    return Array.isArray(input) ? input : Object.values(input || {});
  }

  const TERMINAL_STATUSES = { completed: true, failed: true };
  const PRIORITY_WEIGHT = { critical: 0, high: 1, medium: 2, low: 3 };
  function sortTasks(tasks) {
    return normalizeArray(tasks).sort((a, b) => {
      const terminalA = TERMINAL_STATUSES[a.status] ? 1 : 0;
      const terminalB = TERMINAL_STATUSES[b.status] ? 1 : 0;
      if (terminalA !== terminalB) { return terminalA - terminalB; }
      const prioA = PRIORITY_WEIGHT[a.priority || "medium"] ?? 2;
      const prioB = PRIORITY_WEIGHT[b.priority || "medium"] ?? 2;
      if (prioA !== prioB) { return prioA - prioB; }
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
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
      delete content.dataset.clarificationId;
      delete content.dataset.promptSignature;
      content.innerHTML = "";
      return;
    }

    const promptSignature = getClarificationPromptSignature(active);
    if (
      content.dataset.clarificationId === active.id
      && content.dataset.promptSignature === promptSignature
    ) {
      modal.classList.remove("is-hidden");
      modal.setAttribute("aria-hidden", "false");
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
    content.dataset.clarificationId = active.id;
    content.dataset.promptSignature = promptSignature;
    restoreClarificationDraft(active.id, content);
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

  function removeTaskState(taskId) {
    if (!taskId) return;
    state.teamStatus.tasks = sortTasks(normalizeArray(state.teamStatus.tasks).filter((task) => task.id !== taskId));
    state.teamStatus.clarifications = sortClarifications(
      normalizeArray(state.teamStatus.clarifications).filter((item) => item.taskId !== taskId),
    );
    state.teamStatus.messages = normalizeArray(state.teamStatus.messages).filter((message) => message.taskId !== taskId);
    if (state.selectedTaskId === taskId) {
      state.selectedTaskId = "";
      state.taskDetailData = null;
    }
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

  function removeControllerRunState(runId) {
    if (!runId) return;
    state.teamStatus.controllerRuns = normalizeArray(state.teamStatus.controllerRuns)
      .filter((run) => run.id !== runId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    state.teamStatus.clarifications = sortClarifications(
      normalizeArray(state.teamStatus.clarifications).filter((item) => item.controllerRunId !== runId),
    );
    if (state.selectedPlanningRunId === runId) {
      state.selectedPlanningRunId = "";
    }
  }

  function removeClarificationState(clarificationId) {
    if (!clarificationId) return;
    state.teamStatus.clarifications = sortClarifications(
      normalizeArray(state.teamStatus.clarifications).filter((item) => item.id !== clarificationId),
    );
    if (state.taskDetailData) {
      state.taskDetailData.clarifications = normalizeArray(state.taskDetailData.clarifications)
        .filter((item) => item.id !== clarificationId);
    }
  }

  function removeMessageState(messageId) {
    if (!messageId) return;
    state.teamStatus.messages = normalizeArray(state.teamStatus.messages).filter((message) => message.id !== messageId);
    if (state.taskDetailData) {
      state.taskDetailData.messages = normalizeArray(state.taskDetailData.messages)
        .filter((message) => message.id !== messageId);
    }
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
    return [humanize(task.status || "unknown"), renderWorkerLabel(task), formatTime(task.updatedAt)].filter(Boolean).join(" • ");
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

  function renderExecutionEventTitle(event) {
    if (event && event.stream === "assistant") return "Assistant";
    if (event && event.stream === "tool") return "Tool";
    if (event && event.phase === "user") return "Prompt";
    return humanize((event && (event.phase || event.type)) || "event");
  }

  function renderPlanningExecutionEventEntry(event) {
    return `<article class="timeline-entry"><div class="timeline-head"><div class="task-event-title">${escapeHtml(renderExecutionEventTitle(event))}</div><span class="entry-meta">${escapeHtml(formatDateTime(event.createdAt))}</span></div>${renderMarkdownBlock(event.message || "")}</article>`;
  }

  function renderPlanningTimeline(events) {
    return `<div class="timeline">${events.length ? events.map((event) => renderPlanningExecutionEventEntry(event)).join("") : '<div class="empty-state">No planning timeline yet.</div>'}</div>`;
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
      pillRowEl.innerHTML = [task.priority, task.assignedWorkerId ? renderWorkerLabel(task) : null].filter(Boolean).map((v) => `<span class="mini-pill">${v}</span>`).join("");
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
      `<div class="task-meta-row"><div data-task-detail-role>${task.assignedRole ? renderRoleChip(task.assignedRole) : `<span class="mini-pill">${escapeHtml(t("task.auto"))}</span>`}</div><div class="pill-row" data-task-detail-pills>${[task.priority, task.assignedWorkerId ? renderWorkerLabel(task) : null].filter(Boolean).map((v) => `<span class="mini-pill">${v}</span>`).join("")}</div></div>` +
      `<div class="detail-subtitle" data-task-live-meta>${escapeHtml(buildTaskLiveMeta(task))}</div>` +
      `<div class="row-actions">` +
      `<button class="btn" type="button" data-delete-task="${escapeHtml(task.id || "")}">Delete task</button>` +
      (task.projectDir ? `<button class="btn" type="button" data-delete-project="${escapeHtml(task.projectDir)}" data-delete-project-label="${escapeHtml(task.projectDir)}">Delete project</button>` : "") +
      `</div>` +
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
    const executionEvents = normalizeArray((selectedRun.execution && selectedRun.execution.events) || []);
    const roleCount = requiredRoles.length || candidateRoles.length;
    const detailTitle = selectedRun.source === "task_follow_up"
      ? (selectedRun.title || manifest.requirementSummary || selectedRun.id || t("planning.runFallback"))
      : (manifest.requirementSummary || selectedRun.title || selectedRun.id || t("planning.runFallback"));
    const metaLine = [manifest.projectName, formatDateTime(selectedRun.updatedAt)].filter(Boolean).join(" • ");
    detail.innerHTML = (
      `<div class="planning-detail-shell">` +
      `<section class="planning-hero">` +
      `<div class="detail-kicker">${escapeHtml(t("planning.requirement"))}</div>` +
      `<div class="detail-title">${escapeHtml(detailTitle)}</div>` +
      `<div class="detail-subtitle">${escapeHtml(metaLine)}</div>` +
      `<div class="row-actions">` +
      `<button class="btn" type="button" data-delete-planning-run="${escapeHtml(selectedRun.id || "")}">Delete planning run</button>` +
      (selectedRun.projectDir ? `<button class="btn" type="button" data-delete-project="${escapeHtml(selectedRun.projectDir)}" data-delete-project-label="${escapeHtml(selectedRun.projectDir)}">Delete project</button>` : "") +
      `</div>` +
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
      `<section class="subtle-card"><div class="detail-kicker">Planning timeline</div>${renderPlanningTimeline(executionEvents)}</section>` +
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
              const meta = [renderWorkerLabel(task), formatTime(task.updatedAt || task.createdAt)].filter(Boolean).join(" • ");
              return (
                `<button type="button" class="list-item task-list-item${selected}" data-task-id="${escapeHtml(task.id)}">` +
                `<div class="compact-list-row">` +
                `${renderListIndicator(task.status || "unknown")}` +
                `<div class="list-copy">` +
                `<div class="list-title">${escapeHtml(task.title || task.id || t("task.title"))}</div>` +
              // renderWorkerLabel/formatTime return SAFE html (internally
              // escaped) - escaping the joined string double-escapes it and
              // leaks literal <span title=...> text into the list row.
              `<div class="list-meta">${meta || escapeHtml(compactText(task.description, 120))}</div>` +
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

  async function deleteTaskWithConfirmation(taskId) {
    if (!taskId) return;
    const task = normalizeArray(state.teamStatus.tasks).find((item) => item.id === taskId);
    const label = task && task.title ? task.title : taskId;
    if (!window.confirm(`Delete task "${label}" and all linked clarifications, messages, previews, and timeline data?`)) {
      return;
    }
    setStatusLine(`Deleting task ${label}…`);
    await apiDelete(`/tasks/${encodeURIComponent(taskId)}`);
    const remaining = await apiGetOptional(`/tasks/${encodeURIComponent(taskId)}`, null);
    if (remaining && remaining.task) {
      throw new Error("Task cleanup could not be confirmed");
    }
    removeTaskState(taskId);
    renderMissionSummary();
    renderTasks();
    renderClarifications();
    await refreshWorkspaceTree();
    setStatusLine(`Deleted task ${label}.`);
  }

  async function deletePlanningRunWithConfirmation(runId) {
    if (!runId) return;
    const run = normalizeArray(state.teamStatus.controllerRuns).find((item) => item.id === runId);
    const label = run && (run.title || (run.manifest && run.manifest.requirementSummary)) ? (run.title || run.manifest.requirementSummary) : runId;
    if (!window.confirm(`Delete planning run "${label}" and all related tasks plus their clarifications, messages, previews, and timeline data?`)) {
      return;
    }
    setStatusLine(`Deleting planning run ${label}…`);
    await apiDelete(`/controller/runs/${encodeURIComponent(runId)}`);
    const remaining = await apiGetOptional(`/controller/runs`, { controllerRuns: [] });
    const stillExists = normalizeArray(remaining.controllerRuns).some((item) => item.id === runId);
    if (stillExists) {
      throw new Error("Planning run cleanup could not be confirmed");
    }
    const linkedTaskIds = normalizeArray(state.teamStatus.tasks)
      .filter((task) => task.controllerSessionKey && run && task.controllerSessionKey === run.sessionKey)
      .map((task) => task.id);
    linkedTaskIds.forEach(removeTaskState);
    removeControllerRunState(runId);
    renderMissionSummary();
    renderPlanning();
    renderTasks();
    renderClarifications();
    await refreshWorkspaceTree();
    setStatusLine(`Deleted planning run ${label}.`);
  }

  async function deleteProjectWithConfirmation(projectDir, sourceLabel) {
    if (!projectDir) return;
    const label = sourceLabel || projectDir;
    if (!window.confirm(`Delete project "${label}" and all related planning runs, tasks, clarifications, messages, previews, timeline data, and workspace files?`)) {
      return;
    }
    setStatusLine(`Deleting project ${label}…`);
    await apiDelete(`/projects/${encodeURIComponent(projectDir)}`);
    await refreshAll(true);
    const stillExists = normalizeArray(state.workspaceTree).some((entry) => (entry.path || '') === `projects/${projectDir}`);
    if (stillExists) {
      throw new Error("Project cleanup could not be confirmed");
    }
    setStatusLine(`Deleted project ${label}.`);
  }

  async function openProjectInFinder(projectDir, sourceLabel) {
    if (!projectDir) return;
    if (!canOpenProjectInFinder()) {
      throw new Error("Open in Finder is only available when connected to a local controller.");
    }
    const label = sourceLabel || projectDir;
    setStatusLine(`Opening project ${label} in Finder…`);
    const data = await apiGet(`/workspace/project-path?projectDir=${encodeURIComponent(projectDir)}`);
    await desktop.openPath(data.absolutePath || "");
    setStatusLine(`Opened project ${label} in Finder.`);
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
          const entryPath = entry.path || "";
          const canDeleteProject = /^projects\/[^/]+$/.test(entryPath);
          const canOpenFinder = canDeleteProject && canOpenProjectInFinder();
          const children = Array.isArray(entry.children) ? renderWorkspaceNodes(entry.children, level + 1) : '<ul class="tree-children" style="display:none"></ul>';
          return (
            `<li class="tree-node">` +
            `<div class="tree-row-shell">` +
            `<button type="button" class="tree-row" data-tree-dir="${escapeHtml(entry.path || "")}" data-lazy="${entry.children ? "0" : "1"}">` +
            `<span>${entry.children ? "▾" : "▸"}</span>` +
            `<span>${escapeHtml(entry.name || entry.path || "directory")}</span>` +
            `</button>` +
            (canOpenFinder
              ? `<button type="button" class="mini-btn tree-action-btn" data-open-project-finder="${escapeHtml(entry.name || "")}" data-open-project-finder-label="${escapeHtml(entry.name || "")}" title="Open project in Finder">Finder</button>`
              : "") +
            (canDeleteProject
              ? `<button type="button" class="mini-btn tree-action-btn" data-delete-project="${escapeHtml(entry.name || "")}" data-delete-project-label="${escapeHtml(entry.name || "")}" title="Delete project directory">Delete</button>`
              : "") +
            `</div>` +
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
    pruneClarificationNotifications();
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
          meta: [renderWorkerLabel(task)].filter(Boolean).join(" • "),
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
        renderMissionSummary();
        renderPlanning();
        renderChrome();
        break;
      case "controller:run_deleted":
        removeControllerRunState(data.runId);
        renderMissionSummary();
        renderPlanning();
        renderChrome();
        break;
      case "project:deleted":
        refreshAll(true).catch(() => {});
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
        pruneClarificationNotifications();
        renderNotifications();
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
      case "clarification:deleted":
        removeClarificationState(data.clarificationId);
        pruneClarificationNotifications();
        renderNotifications();
        renderMissionSummary();
        renderClarifications();
        if (state.currentView === "tasks" && state.selectedTaskDetailTab === "clarifications") {
          renderTaskDetailContent();
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
          meta: [renderWorkerLabel(task)].filter(Boolean).join(" • "),
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
      case "task:deleted":
        removeTaskState(data.taskId);
        renderMissionSummary();
        renderTasks();
        renderClarifications();
        break;
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
      case "message:deleted":
        removeMessageState(data.messageId);
        if (state.currentView === "tasks" && state.selectedTaskDetailTab === "messages") {
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
      if (state.currentView === "controller") {
        renderControllerSettings();
      }
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
    const data = await apiGetOptional("/reports", { reports: [] });
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
        apiGetOptional("/reports", { reports: [] }),
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
    bootShell("boot.connecting");
    renderChrome();
    try {
      state.controllerUrl = normalizeBaseUrl(url);
      if (!state.controllerUrl) throw new Error("Controller URL is required");
      $("#controller-url").value = state.controllerUrl;
      state.settings = await desktop.saveSettings({ ...(state.settings || {}), controllerUrl: state.controllerUrl });
      await refreshAll(false);
      unveilShell();
      state.unavailableScreenVisible = false;
      state.unavailableReason = "";
      connectWs();
      state.connectionExpanded = false;
      setStatusLine(t("connection.connectedTo", { url: state.controllerUrl }));
      renderChrome();
    } finally {
      state.isConnecting = false;
      // Failed connect: lift the boot gate so the disconnect state (and the
      // URL editor) is reachable - the gate only stays for a successful boot.
      if (state.connectionState !== "connected") unveilShell();
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
    const getScopedField = (selector) => {
      return card.querySelector(selector) || document.querySelector(selector);
    };
    const submitButton = sourceElement instanceof HTMLButtonElement ? sourceElement : null;
    const originalLabel = submitButton ? submitButton.textContent : "";
    const body = { answeredBy: 'human-desktop' };
    if (!schema || !schema.kind) {
      const textarea = getScopedField(`[data-clarification-answer="${CSS.escape(id)}"]`);
      const answer = textarea ? textarea.value.trim() : '';
      if (!answer) {
        setStatusLine('Please provide an answer before submitting.');
        return;
      }
      body.answer = answer;
    } else if (schema.kind === 'single-select') {
      const selected = card.querySelector(`input[data-clarification-choice="${CSS.escape(id)}"]:checked`);
      if (!selected) {
        setStatusLine('Please choose an answer before submitting.');
        return;
      }
      if (selected.value === '__other__') {
        const other = card.querySelector(`[data-clarification-other="${CSS.escape(id)}"]`);
        body.answerValue = other ? other.value.trim() : '';
      } else {
        body.answerValue = selected.value;
      }
      const comment = card.querySelector(`[data-clarification-comment="${CSS.escape(id)}"]`);
      if (comment && comment.value.trim()) body.answerComment = comment.value.trim();
      if (!body.answerValue && !body.answerComment) {
        setStatusLine('Please choose an answer before submitting.');
        return;
      }
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
      if (!body.answerValues && !body.answerComment) {
        setStatusLine('Please choose at least one answer before submitting.');
        return;
      }
    } else if (schema.kind === 'number') {
      const numberInput = card.querySelector(`[data-clarification-number="${CSS.escape(id)}"]`);
      const raw = numberInput ? numberInput.value.trim() : '';
      if (raw) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) body.answerNumber = parsed;
      }
      const comment = card.querySelector(`[data-clarification-comment="${CSS.escape(id)}"]`);
      if (comment && comment.value.trim()) body.answerComment = comment.value.trim();
      if (body.answerNumber == null && !body.answerComment) {
        setStatusLine('Please provide a number or note before submitting.');
        return;
      }
    } else {
      const textarea = getScopedField(`[data-clarification-answer="${CSS.escape(id)}"]`);
      const answer = textarea ? textarea.value.trim() : '';
      if (!answer) {
        setStatusLine('Please provide an answer before submitting.');
        return;
      }
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
        delete state.clarificationDrafts[id];
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
      const message = error instanceof Error ? error.message : 'Failed to answer clarification';
      if (
        typeof message === 'string'
        && (
          message.includes('already answered')
          || message.includes('not found')
        )
      ) {
        refreshAll(true).catch(() => {});
      }
      setStatusLine(message);
    }
  }

  async function connectSavedController() {
    state.settings = await desktop.getSettings();
    state.localSetupInfo = await desktop.getLocalSetupInfo();
    // No implicit localhost fallback: connecting somewhere the user never
    // chose (a host production controller on 9527) is worse than showing the
    // setup screen. Only an explicitly saved URL is used here.
    const defaultUrl = state.settings.controllerUrl || '';
    $('#controller-url').value = defaultUrl;
    state.controllerUrl = defaultUrl;
    if (!defaultUrl) {
      renderChrome();
      renderUnavailableScreen();
      return;
    }
    state.localSetupMode = 'controller-manual';
    if (state.localSetupInfo && Array.isArray(state.localSetupInfo.modes)) {
      const preferredMode = state.localSetupInfo.modes.find((entry) => entry.recommended) || state.localSetupInfo.modes[0];
      if (preferredMode && preferredMode.id) {
        state.localSetupMode = preferredMode.id;
      }
    }
    renderChrome();
    renderUnavailableScreen();
    // Always auto-connect on boot: saved URL or the local default. The boot
    // gate (inside connectController) covers the window until first data
    // renders; failures fall through to the setup screen.
    {
      try {
        await connectController(defaultUrl, { skipConversation: true });
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
    // Sandbox = blank machine: NEVER fall back to the host's production
    // controller on 9527 - an empty saved URL means show the setup state,
    // not dial whatever else runs on this host.
    const fallbackUrl = state.settings && state.settings.sandbox ? '' : 'http://127.0.0.1:9527';
    const reconnectUrl = normalizeBaseUrl(
      state.controllerUrl
        || (state.settings && state.settings.controllerUrl)
        || fallbackUrl,
    );
    if (!reconnectUrl) {
      state.unavailableScreenVisible = true;
      renderUnavailableScreen();
      return;
    }
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
  $('#wizard-language-toggle').addEventListener('click', function () {
    setLanguage(state.language === 'zh' ? 'en' : 'zh');
  });
  $('#compose-focus-btn').addEventListener('click', function () {
    activateView('mission');
    $('#composer-input').focus();
  });
  $('#composer-send').addEventListener('click', submitComposer);
  // Pill click = change-server entry: connected pill expands the URL editor
  // (was the Edit button, now removed from the chrome).
  $('#connection-pill').addEventListener('click', function () {
    if (state.connectionState !== 'connected') return;
    state.connectionExpanded = !state.connectionExpanded;
    renderChrome();
    if (state.connectionExpanded) {
      const input = $('#controller-url');
      if (input) { input.focus(); input.select(); }
    }
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
      // Sandboxed orchestrated install (never touches the user's global
      // installs): OpenClaw runtime -> TeamClaw extension -> LLM config,
      // with every step streamed into the progress log.
      const hasOpenClaw = Boolean(state.localSetupInfo && state.localSetupInfo.hasOpenClaw);
      state.isInstallingLocal = hasOpenClaw;
      state.isInstallingOpenClaw = !hasOpenClaw;
      state.unavailableReason = t("bootstrap.installing");
      renderUnavailableScreen();

      const logCard = document.getElementById('bootstrap-log-card');
      const logEl = document.getElementById('bootstrap-log');
      if (logCard && logEl) { logCard.hidden = false; logEl.textContent = ''; }
      const appendLog = (payload) => {
        if (!logEl) return;
        const { phase = '', line = '' } = payload || {};
        const row = document.createElement('div');
        if (phase === 'error') row.className = 'log-error';
        row.textContent = line ? `[${phase}] ${line}` : `[${phase}]`;
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
      };
      const unsub = window.teamclawDesktop && window.teamclawDesktop.onBootstrapEvent
        ? window.teamclawDesktop.onBootstrapEvent(appendLog)
        : null;

      const providerEl = document.getElementById('bootstrap-llm-provider');
      const endpointEl = document.getElementById('bootstrap-llm-endpoint');
      const apikeyEl = document.getElementById('bootstrap-llm-apikey');
      const modelEl = document.getElementById('bootstrap-llm-model');
      const sourceEl = document.getElementById('bootstrap-source');
      const artifactEl = document.getElementById('bootstrap-artifact-url');
      const source = sourceEl && sourceEl.value !== 'auto' ? sourceEl.value : undefined;
      const artifactUrl = source === 'artifact' && artifactEl ? artifactEl.value.trim() : undefined;
      const llm = (providerEl && providerEl.value && apikeyEl && apikeyEl.value.trim())
        ? { provider: providerEl.value, endpoint: endpointEl ? endpointEl.value.trim() : '', apiKey: apikeyEl.value.trim(), model: modelEl ? modelEl.value.trim() : '' }
        : {};

      const installPromise = desktop.bootstrapInstall({ llm, source, artifactUrl })
        .finally(() => { if (unsub) unsub(); });
      installPromise.then(async () => {
        state.isInstallingLocal = false;
        state.isInstallingOpenClaw = false;
        // `inst` must be read HERE: the outer scopes never define it, and the
        // ReferenceError it used to throw was silently swallowed - the
        // post-install connect hop never actually ran until this line.
        const inst = await desktop.instanceGet().catch(() => null);
        state.unavailableReason = "";
        state.localSetupInfo = await desktop.getLocalSetupInfo();
        // Last hop (the "it just works" moment): after a successful install,
        // start the private instance, wait for the controller announce, connect
        // - and open the dashboard in the browser like a running install does.
        try {
          const wizLog = (line) => { const el = document.getElementById("bootstrap-log"); if (el) el.textContent += `\n[connect] ${line}`; };
          const st = await desktop.standaloneStart({}, inst || null).catch((e) => { wizLog("start failed: " + (e && e.message)); return null; });
          if (st && st.controllerUrl) {
            wizLog("instance up at " + st.controllerUrl + " - waiting for controller...");
            let ok = false;
            for (let i = 0; i < 45 && !ok; i++) {
              try { const res = await fetch(`${st.controllerUrl}/api/v1/tunnel/status`, { signal: AbortSignal.timeout(1500) }); ok = res.ok; } catch {}
              if (!ok) await new Promise((w) => setTimeout(w, 1500));
            }
            if (ok) {
              await desktop.instanceSet({ mode: "private", lifecycle: (inst && inst.lifecycle) || "app", controllerUrl: st.controllerUrl, gatewayPort: st.port || null, controllerPort: st.controllerPort || null, llmConfigured: true }).catch(() => {});
              await connectController(st.controllerUrl, { skipConversation: true }).catch((e) => wizLog("connect failed: " + (e && e.message)));
              // Desktop private instance intentionally does NOT open the
              // web UI in a browser - the desktop app IS the UI (user ruling).
              return;
            }
            wizLog("controller never answered on " + st.controllerUrl);
          } else if (st) {
            wizLog("instance started but no controller URL (announce timeout)");
          }
        } catch (e) { const el = document.getElementById("bootstrap-log"); if (el) el.textContent += `\n[connect] unexpected: ${e && e.message}`; }
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

    const deleteTaskButton = target.closest('[data-delete-task]');
    if (deleteTaskButton) {
      deleteTaskWithConfirmation(deleteTaskButton.dataset.deleteTask || '').catch((error) => {
        setStatusLine(error instanceof Error ? error.message : 'Failed to delete task');
      });
      return;
    }

    const deletePlanningRunButton = target.closest('[data-delete-planning-run]');
    if (deletePlanningRunButton) {
      deletePlanningRunWithConfirmation(deletePlanningRunButton.dataset.deletePlanningRun || '').catch((error) => {
        setStatusLine(error instanceof Error ? error.message : 'Failed to delete planning run');
      });
      return;
    }

    const deleteProjectButton = target.closest('[data-delete-project]');
    if (deleteProjectButton) {
      deleteProjectWithConfirmation(
        deleteProjectButton.dataset.deleteProject || '',
        deleteProjectButton.dataset.deleteProjectLabel || '',
      ).catch((error) => {
        setStatusLine(error instanceof Error ? error.message : 'Failed to delete project');
      });
      return;
    }

    const openProjectFinderButton = target.closest('[data-open-project-finder]');
    if (openProjectFinderButton) {
      openProjectInFinder(
        openProjectFinderButton.dataset.openProjectFinder || '',
        openProjectFinderButton.dataset.openProjectFinderLabel || '',
      ).catch((error) => {
        setStatusLine(error instanceof Error ? error.message : 'Failed to open project in Finder');
      });
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
      const node = row.closest('.tree-node');
      const container = node ? node.querySelector(':scope > .tree-children') : null;
      if (!container) return;
      const hidden = container.style.display === 'none';
      if (hidden) {
        container.style.display = '';
        if (row.firstElementChild) row.firstElementChild.textContent = '▾';
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
        if (row.firstElementChild) row.firstElementChild.textContent = '▸';
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
    const clarificationCard = target.closest('[data-clarification-card]');
    if (clarificationCard) {
      const clarificationId = clarificationCard.getAttribute('data-clarification-card') || '';
      if (clarificationId) {
        rememberClarificationDraft(clarificationId, clarificationCard);
      }
    }
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

  document.addEventListener('input', function (event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const clarificationCard = target.closest('[data-clarification-card]');
    if (!clarificationCard) return;
    const clarificationId = clarificationCard.getAttribute('data-clarification-card') || '';
    if (!clarificationId) return;
    rememberClarificationDraft(clarificationId, clarificationCard);
  });

  applyStaticTranslations();

  // ---------- day / night theme ----------
  const THEME_KEY = "teamclaw-theme";
  const themeToggle = document.getElementById("theme-toggle");
  const themeLabel = document.getElementById("theme-toggle-label");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    const pref = localStorage.getItem(THEME_KEY) || "system";
    const dark = pref === "night" || (pref !== "day" && systemDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "day";
    if (themeLabel) {
      themeLabel.textContent = dark ? "Night" : "Day";
    }
    if (desktop?.applyTheme) {
      desktop.applyTheme(dark ? "night" : "day").catch(() => {});
    }
  }
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      const current = document.documentElement.dataset.theme === "dark" ? "night" : "day";
      const next = current === "night" ? "day" : "night";
      localStorage.setItem(THEME_KEY, next);
      desktop?.saveSettings({ theme: next }).catch(() => {});
      applyTheme();
    });
  }
  systemDark.addEventListener("change", () => {
    const pref = localStorage.getItem(THEME_KEY) || "system";
    if (pref === "system") applyTheme();
  });
  applyTheme();

  // ---------- internet tunnel (controller view) ----------
  function tunnelEls() {
    return {
      state: document.getElementById("ctl-tunnel-state"),
      share: document.getElementById("ctl-tunnel-share"),
      stop: document.getElementById("ctl-tunnel-stop"),
      install: document.getElementById("ctl-tunnel-install"),
      result: document.getElementById("ctl-tunnel-result"),
    };
  }

  function renderTunnelPanel(st) {
    const els = tunnelEls();
    if (!els.state) return;
    const connected = state.connectionState === "connected";
    if (!connected || !st) {
      els.state.textContent = connected ? t("ctl.tunnel.loading") : t("ctl.tunnel.errNotConnected");
      els.share.hidden = true;
      els.stop.hidden = true;
      els.install.hidden = true;
      return;
    }
    els.share.hidden = true;
    els.stop.hidden = true;
    els.install.hidden = true;
    const progress = st.startOp && st.startOp.running
      ? t("ctl.tunnel.starting") + ": " + (st.startOp.phase || "") + "…"
      : st.install && st.install.running
        ? t("ctl.tunnel.installing") + (st.install.percent != null ? " " + st.install.percent + "%" : "") + "…"
        : null;
    if (progress) {
      els.state.textContent = progress;
      return;
    }
    if (st.active && st.hostname) {
      els.state.innerHTML =
        '<span class="ctl-tunnel-live">' + escapeHtml(t("ctl.tunnel.live")) + '</span>'
        + ' <a href="https://' + escapeHtml(st.hostname) + '" target="_blank" rel="noopener">https://' + escapeHtml(st.hostname) + '</a>'
        + ' · ' + escapeHtml(t("ctl.tunnel.gateToken")) + ': <b class="ctl-tunnel-token">' + escapeHtml(st.gateToken || "-") + '</b>';
      els.stop.hidden = false;
      return;
    }
    if (st.cloudflaredInstalled === false) {
      els.state.textContent = t("ctl.tunnel.notInstalled");
      els.install.hidden = false;
      return;
    }
    els.state.textContent = t("ctl.tunnel.off");
    els.share.hidden = false;
  }

  async function refreshTunnelPanel() {
    if (!document.getElementById("ctl-tunnel-state")) return;
    if (state.connectionState !== "connected") {
      renderTunnelPanel(null);
      return;
    }
    const errEl = document.getElementById("ctl-tunnel-result");
    try {
      const st = await apiGet("/tunnel/status");
      if (errEl) { errEl.textContent = ""; errEl.classList.remove("ctl-error"); }
      renderTunnelPanel(st);
    } catch (err) {
      // Transient failures (e.g. right after connect) self-heal on the next
      // 5s poll; keep the last error visible until then.
      if (errEl) {
        errEl.textContent = err && err.message ? err.message : String(err);
        errEl.classList.add("ctl-error");
      }
      renderTunnelPanel(null);
    }
  }

  async function tunnelAction(path, btn) {
    const els = tunnelEls();
    if (!btn) return;
    btn.disabled = true;
    if (els.result) els.result.textContent = "";
    try {
      await apiPost(path);
    } catch (err) {
      if (els.result) {
        els.result.textContent = t("ctl.tunnel.actionFailed") + (err && err.message ? err.message : String(err));
        els.result.classList.add("ctl-error");
      }
    } finally {
      btn.disabled = false;
      refreshTunnelPanel();
    }
  }

  const tunnelShareBtn = document.getElementById("ctl-tunnel-share");
  const tunnelStopBtn = document.getElementById("ctl-tunnel-stop");
  const tunnelInstallBtn = document.getElementById("ctl-tunnel-install");
  if (tunnelShareBtn) tunnelShareBtn.addEventListener("click", () => tunnelAction("/tunnel/start", tunnelShareBtn));
  if (tunnelStopBtn) tunnelStopBtn.addEventListener("click", () => {
    if (window.confirm(t("ctl.tunnel.stop") + "?")) tunnelAction("/tunnel/stop", tunnelStopBtn);
  });
  if (tunnelInstallBtn) tunnelInstallBtn.addEventListener("click", () => tunnelAction("/tunnel/install-cloudflared", tunnelInstallBtn));
  refreshTunnelPanel();
  setInterval(refreshTunnelPanel, 5000);

  setStatusLine(t("connection.waiting"));
  setSummaryLine(t("connection.noSummary"));
  setConnectionPill("disconnected", t("connection.disconnected"));
  setupGithubCorner();
  // S2: connection card - wizard entry + private instance stop button.
  {
    const wizBtn = document.getElementById('wizard-open-btn');
    if (wizBtn) wizBtn.addEventListener('click', () => {
      state.unavailableScreenVisible = true;
      renderUnavailableScreen();
      wizardGoStep(1);
    });
    const wizCancel = document.getElementById('wizard-cancel-btn');
    if (wizCancel) wizCancel.addEventListener('click', () => {
      state.unavailableScreenVisible = false;
      renderUnavailableScreen();
      // Explicit user dismissal wins over the boot-gate keep-open: without
      // this the "not connected yet" branch re-shows the overlay instantly
      // and cancel appears dead.
      const ov = document.getElementById('bootstrap-overlay');
      if (ov) ov.classList.add('hidden');
    });
    const stopBtn = document.getElementById('standalone-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try { await desktop.standaloneStop(); } catch { /* ipc gone */ }
      stopBtn.disabled = false;
    });
  }
  bindTeamAutoControls();
  // Bootstrap: artifact source reveals the URL input (fixed GitHub release by default).
  {
    const sel = document.getElementById('bootstrap-source');
    const gl = document.getElementById('bootstrap-artifact-url');
    if (sel && gl) sel.addEventListener('change', () => { gl.hidden = sel.value !== 'artifact'; });
  }
  // Standalone instance controls (fully isolated OpenClaw+TeamClaw).
  {
    const pill = document.getElementById('standalone-pill');
    const startBtn = document.getElementById('standalone-start-btn');
    const connectBtn = document.getElementById('standalone-connect-btn');
    const vendorSel = document.getElementById('standalone-vendor');
    const refreshStandalone = async () => {
      try {
        const st = await desktop.standaloneStatus();
        if (pill) pill.className = 'pill ' + (st.running ? 'pill-connected' : 'pill-stopped');
        if (pill) pill.textContent = st.running ? 'Running :' + st.port : 'Stopped';
        if (startBtn) startBtn.hidden = st.running;
        if (connectBtn) connectBtn.hidden = !st.running;
        const stopBtn2 = document.getElementById('standalone-stop-btn');
        if (stopBtn2) stopBtn2.hidden = !st.running;
        if (connectBtn) connectBtn.dataset.url = st.controllerUrl || '';
      } catch { /* ipc gone */ }
    };
    if (startBtn) startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        const r = await desktop.standaloneStart(vendorSel && vendorSel.value ? { preferredVendor: vendorSel.value } : {});
        setStatusLine('Standalone instance on port ' + r.port);
      } catch (e) { setStatusLine(e instanceof Error ? e.message : 'start failed'); }
      startBtn.disabled = false;
      refreshStandalone();
    });
    if (connectBtn) connectBtn.addEventListener('click', () => {
      const url = connectBtn.dataset.url;
      if (url) connectController(url, { skipConversation: true }).catch(() => {});
    });
    refreshStandalone();
    setInterval(refreshStandalone, 5000);
  }
  // Readiness gate (S1): ready -> auto standalone start; else wizard.
  (async () => {
    // SOT gate v3: settings.instance is the single source of truth.
    const inst = await desktop.instanceGet().catch(() => null);
    if (inst && inst.mode === "external" && inst.controllerUrl) {
      await connectController(inst.controllerUrl, { skipConversation: true }).catch(() => {});
      unveilShell();
      return;
    }
    if (inst && inst.mode === "global") {
      // Reconnect to the global gateway recorded at wizard time.
      if (inst.controllerUrl) {
        await connectController(inst.controllerUrl, { skipConversation: true }).catch(() => {});
        unveilShell();
        return;
      }
    }
    if (!inst || inst.mode === "private") {
      // Migration + private path: a ready sandbox with no instance record yet
      // (pre-SOT installs) is adopted as private automatically.
      try {
        const r = await desktop.runtimeIsReady();
      if (r && r.ready) {
        bootShell("boot.startingInstance");
        const st = await desktop.standaloneStart({}, inst || null).catch(() => null);
        if (st && st.controllerUrl) {
          // Gateway just spawned: poll until the controller answers (<=30s),
          // then connect. Transient failures retry inside the window.
          let ok = false;
          for (let i = 0; i < 30 && !ok; i++) {
            try { const res = await fetch(`${st.controllerUrl}/api/v1/tunnel/status`, { signal: AbortSignal.timeout(1500) }); ok = res.ok; } catch {}
            if (!ok) await new Promise((w) => setTimeout(w, 1000));
          }
          if (ok) {
            await connectController(st.controllerUrl, { skipConversation: true }).catch(() => {});
            await desktop.instanceSet({ mode: "private", lifecycle: (inst && inst.lifecycle) || "app", controllerUrl: st.controllerUrl, gatewayPort: st.port || null, controllerPort: st.controllerPort || null, llmConfigured: true }).catch(() => {});
            unveilShell();
            return;
          }
        }
        unveilShell();
      }
    } catch { unveilShell(); }
    }
    // No usable instance record -> wizard, with the DEFAULT option chosen
    // from a read-only environment probe (user spec):
    //   global openclaw + teamclaw -> connect existing (option 3 selected)
    //   openclaw only              -> install into it (global) by default
    //   neither                    -> full global install by default
    state.unavailableScreenVisible = true;
    renderUnavailableScreen();
    try {
      const env = await desktop.envDetect();
      state.envDetect = env;
      const pick = (mode) => {
        const el = document.querySelector(`input[name="bootstrap-mode"][data-bootstrap-mode="${mode}"]`);
        if (el) { el.checked = true; el.dispatchEvent(new Event("change")); }
      };
      // Sandbox = blank machine (user rule): the wizard defaults to the
      // PRIVATE instance and never pre-fills the host's real controller URL.
      // Host-probing defaults only apply to a normal (non-sandbox) launch.
      if (state.settings && state.settings.sandbox) {
        pick("controller-manual");
      } else if (env.openclaw && env.teamclawInGlobal) {
        pick("remote");
        const urlEl = document.getElementById("bootstrap-controller-url");
        if (urlEl && env.globalControllerUrl) urlEl.value = env.globalControllerUrl;
      } else if (env.openclaw) {
        pick("global"); // install into the existing global instance
      } else {
        pick("global"); // full global install is the default path
      }
    } catch { /* keep defaults */ }
    wizardGoStep(1);
  })();
  bindWizardControls();
  connectSavedController();
  renderConversation();
  activateView('mission');
  renderChrome();
})();
