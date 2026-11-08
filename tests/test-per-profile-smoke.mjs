#!/usr/bin/env node
// Phase 5.4 (vertical-team-profiles-design.md Phase 5 table row 5.4):
// per-profile behavioral smoke, one instance per pack, run against the built
// dist modules (run `npm --prefix src run build` first).
//
// The row's four assertion families distribute as:
//   * "载入→预热→发一条中文任务→路由角色正确" -> section 1 below (per pack,
//     every warmupRole probed with a Chinese task that the dist role-inference
//     fast path must route confidently; software-rd pins its designed
//     mixed-ASCII + pure-Chinese-escalates semantics), plus the warmup
//     dispatch pin in section 3 (switch step 5).
//   * "金融包断言免责尾注出现" -> section 2: for banking/securities/insurance
//     the outputConstraints.tailnote exists verbatim, is carried by a
//     domainInstructions line (P2.4 dual landing), and survives into a
//     RENDERED worker prompt (test-domain-instructions.mjs renders only the
//     minimal-bank fixture; here each real finance pack renders once).
//   * "切换→归档→重预热路径 roundtrip" -> section 3: software-rd -> banking
//     (all-false capabilities) and -> crossborder-ecom, through the real
//     dist http-server with a stub provisioning manager (the
//     test-profile-switch.mjs deps-stub pattern): archive file exists and
//     parses, profileId flips, and warmRolesForTeamSwitch is dispatched with
//     exactly the target pack's warmupRoles.
//   * "capability 禁用路由 404 + 错误体 capability 字段" -> section 3 probes
//     it on the banking scenario (steady-state 404 short-circuit). The full
//     route-family matrix stays in tests/test-capability-gates.mjs; this
//     keeps the CI row self-contained with one representative probe per
//     disabled capability family touched by the banking roundtrip.
//
// The pack list is directory-discovered (same contract as
// tests/test-profile-packs.mjs), so a new pack without a probe table fails
// loudly instead of silently skipping CI coverage.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const dist = (rel) => import(path.join(projectRoot, "src", "dist", "src", rel));

// --- env must be in place before the first dist import ----------------------
// No TEAMCLAW_EXTRA_PROFILES_DIR: this smoke exercises the production
// built-in load path (dist/src/profiles) exclusively.
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-per-profile-smoke-"));
process.env.OPENCLAW_STATE_DIR = stateRoot;
const stateDir = path.join(stateRoot, "plugins", "teamclaw");
fs.mkdirSync(stateDir, { recursive: true });
process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tc-pp-smoke-ws-"));

const loaderMod = await dist("profile-loader.js");
const inferenceMod = await dist("controller/role-inference.js");
const { parsePluginConfig } = await dist("types.js");
const { createWorkerPromptInjector } = await dist("worker/prompt-injector.js");
const { MessageQueue } = await dist("worker/message-queue.js");

const { inferTaskRole, inferTaskRoleWithConfidence } = inferenceMod;

// --- discovery: every packaged profile except schema.json -------------------
const SOURCE_PROFILES_DIR = path.join(projectRoot, "src", "src", "profiles");
const packFiles = fs.readdirSync(SOURCE_PROFILES_DIR)
  .filter((name) => name.endsWith(".json") && name !== "schema.json")
  .sort();
assert.equal(
  packFiles.length,
  6,
  `expected exactly the six profile packages (baseline + five industry), found: ${packFiles.join(", ")}`,
);

// ---------------------------------------------------------------------------
// Chinese task probes, one per warmupRole (plus explicit extras).
//
// Each probe text embeds a HIGH-DISTINCTIVENESS bilingual token of the target
// role (from the pack's capabilitiesZh entries, e.g. banking 反洗钱 ->
// aml-analyst, 押品估值 -> risk-reviewer; insurance 核保 -> underwriter), so
// the fast path must return reason "confident" - a tie/all-zero verdict would
// mean the pack's routing tokens degraded.
//
// The `expectRole: null` entry pins the software-rd designed semantics
// (test-role-inference-cjk.mjs section b): pure-Chinese text escalates
// (all-zero) and the caller resolves via the profile defaultRole.
// ---------------------------------------------------------------------------
const PROBES = {
  banking: [
    { expectRole: "credit-officer", title: "整理某制造业客户 2 亿授信申请的贷前调查材料", description: "客户要求下周提交对公信贷尽调初稿" },
    { expectRole: "risk-reviewer", title: "复核押品估值口径变更", description: "新规下押品估值需要统一审查" },
    { expectRole: "approver", title: "准备下周贷审会材料", description: "三笔授信额度审批上会" },
    { expectRole: "post-loan-manager", title: "开展季度贷后检查", description: "风险分类下调需要预警复核" },
    // Domain-review probe reused from the banking review wave: 反洗钱 is the
    // aml-analyst's distinctive token (not a warmup role - routing must still
    // reach it, matching the credit-file workflows of the pack).
    { expectRole: "aml-analyst", title: "排查一笔可疑交易的名单筛查命中", description: "疑似洗钱链条交易监测分析" },
  ],
  securities: [
    { expectRole: "industry-researcher", title: "更新新能源行业研究框架", description: "行业研究员季度跟踪" },
    { expectRole: "macro-researcher", title: "梳理宏观研究员关注的利率传导框架", description: "宏观研究月度更新" },
    { expectRole: "quant-analyst", title: "回测多因子框架的数据需求清单", description: "量化研究因子库维护" },
  ],
  insurance: [
    { expectRole: "underwriter", title: "核保规则调整：高龄投保人补充告知", description: "根据新监管要求调整核保规则" },
    { expectRole: "claims-adjuster", title: "车险理赔案件材料初审", description: "理赔查勘任务分派" },
    { expectRole: "actuary-analyst", title: "重疾产品经验分析的数据需求", description: "精算助理季度假设更新" },
  ],
  "crossborder-ecom": [
    { expectRole: "store-ops", title: "美区店铺运营周报整理", description: "店铺运营促销节奏排期" },
    { expectRole: "sourcing-analyst", title: "选品分析师季度潜力品类清单", description: "竞品站内数据需求整理" },
    { expectRole: "listing-specialist", title: "优化五点描述的 Listing 文案", description: "listing 关键词覆盖检查" },
    { expectRole: "traffic-growth-manager", title: "调整广告投放预算框架", description: "流量增长经理周会" },
  ],
  "trading-co": [
    { expectRole: "order-merchandiser", title: "跟单员更新订单交期台账", description: "跟单异常反馈处理" },
    { expectRole: "market-developer", title: "市场开发新客户背景调查", description: "德国市场开发线索" },
    { expectRole: "documentation-specialist", title: "制作信用证单证审核清单", description: "单证专员交单单据核对" },
  ],
  "software-rd": [
    // Mixed CJK/ASCII text routes via the 2-char ASCII token (Phase 0.1 fix).
    { expectRole: "developer", title: "作为developer我想修复导出接口的空指针报错", description: "" },
    // Pure-Chinese text under the software-rd registry escalates by design;
    // the caller then resolves via the profile defaultRole (developer).
    { expectRole: null, reason: "all-zero", title: "整理一份产品需求评审纪要", description: "纯中文任务文本" },
  ],
};

const perPackSummary = [];

// ---------------------------------------------------------------------------
// Section 1: load + Chinese-task routing, one instance per pack.
// ---------------------------------------------------------------------------
for (const file of packFiles) {
  const raw = JSON.parse(await fs.promises.readFile(path.join(SOURCE_PROFILES_DIR, file), "utf8"));
  const packId = raw.id;
  const probes = PROBES[packId];
  assert.ok(
    Array.isArray(probes) && probes.length >= 2,
    `pack ${file} has no probe table in tests/test-per-profile-smoke.mjs - every discovered pack needs per-warmup-role Chinese probes (design Phase 5.4)`,
  );

  // 载入: the built-in dist registry carries the pack (importing the dist
  // loader has already run the fatal validation pipeline over all of them).
  const pack = loaderMod.BUILTIN_PROFILES.get(packId);
  assert.ok(pack, `pack ${file} (id "${packId}") must be in the dist built-in registry - run \`npm --prefix src run build\``);

  // Coverage guard: every warmupRole of the pack is probed (the null-escalates
  // probes cannot stand in for a warmup role).
  const probedRoles = new Set(probes.filter((probe) => probe.expectRole !== null).map((probe) => probe.expectRole));
  for (const roleId of pack.warmupRoles) {
    assert.ok(
      probedRoles.has(roleId),
      `pack ${packId}: warmupRole "${roleId}" has no Chinese routing probe - add one (design Phase 5.4: 载入→预热→发一条中文任务→路由角色正确)`,
    );
  }

  loaderMod.setActiveProfileId(packId);
  let routed = 0;
  for (const probe of probes) {
    const verdict = inferTaskRoleWithConfidence({
      assignedRole: undefined,
      title: probe.title,
      description: probe.description,
    });
    if (probe.expectRole === null) {
      // Designed escalation: fast path refuses, caller owns the fallback.
      assert.equal(
        inferTaskRole({ assignedRole: undefined, title: probe.title, description: probe.description }),
        null,
        `pack ${packId}: pure-Chinese probe "${probe.title}" must escalate (null) instead of guessing`,
      );
      assert.equal(verdict.reason, probe.reason, `pack ${packId}: probe "${probe.title}" verdict reason`);
      assert.equal(verdict.needsLlmFallback, true, `pack ${packId}: probe "${probe.title}" must demand the fallback owner`);
      assert.equal(
        loaderMod.getActiveDefaultRole(),
        "developer",
        `pack ${packId}: the escalated probe resolves via the software-rd defaultRole developer`,
      );
    } else {
      assert.equal(
        verdict.role,
        probe.expectRole,
        `pack ${packId}: Chinese task "${probe.title}" must route to ${probe.expectRole}, got ${verdict.role} (reason ${verdict.reason})`,
      );
      assert.equal(
        verdict.reason,
        "confident",
        `pack ${packId}: probe "${probe.title}" must be a CONFIDENT fast-path route (got ${verdict.reason}${verdict.role ? ` winner=${verdict.role}` : ""}) - a tie/all-zero means the pack's bilingual routing tokens degraded`,
      );
      routed += 1;
    }
  }
  perPackSummary.push(`${packId} routing=${routed}/${probes.length}`);
  console.log(`PASS routing ${packId}: ${probes.length} Chinese task probe(s), ${routed} confident fast-path route(s), warmupRoles covered (${pack.warmupRoles.join(", ")})`);
}

// ---------------------------------------------------------------------------
// Section 2: finance disclaimer tailnote, pack data + rendered worker prompt.
// ---------------------------------------------------------------------------
const FINANCE_PACK_IDS = ["banking", "securities", "insurance"];
for (const packId of FINANCE_PACK_IDS) {
  const pack = loaderMod.BUILTIN_PROFILES.get(packId);
  const tailnote = pack.outputConstraints?.tailnote;
  assert.ok(
    typeof tailnote === "string" && tailnote.trim().length > 0,
    `finance pack ${packId} must set outputConstraints.tailnote (design Phase 3 hard requirement)`,
  );
  // P2.4 dual landing: the tailnote also lives in a domainInstructions line,
  // which is what actually carries it into rendered prompts.
  assert.ok(
    pack.domainInstructions.some((line) => line.includes(tailnote)),
    `finance pack ${packId}: a domainInstructions line must embed the tailnote verbatim (P2.4 dual landing)`,
  );

  // Prompt-level: render one worker prompt under the pack (its defaultRole)
  // the same way tests/test-domain-instructions.mjs renders, and require the
  // tailnote text to survive injection.
  loaderMod.setActiveProfileId(packId);
  const injector = createWorkerPromptInjector(
    parsePluginConfig({
      mode: "worker",
      role: pack.defaultRole,
      teamName: "Per-Profile Smoke",
      controllerUrl: "http://127.0.0.1:9527",
    }),
    () => ({
      workerId: `pp-smoke-${packId}-1`,
      role: pack.defaultRole,
      controllerUrl: "http://127.0.0.1:9527",
      registeredAt: 1730000000000,
    }),
    new MessageQueue(),
  );
  const prompt = injector()?.prependSystemContext ?? "";
  assert.ok(prompt.length > 0, `finance pack ${packId}: worker prompt must render`);
  assert.ok(prompt.includes("## TeamClaw Operating Contract"), `finance pack ${packId}: worker prompt keeps the Operating Contract section`);
  assert.ok(
    prompt.includes(tailnote),
    `finance pack ${packId}: the RENDERED worker prompt must contain the disclaimer tailnote verbatim: ${tailnote}`,
  );
  perPackSummary.push(`${packId} tailnote=prompt`);
  console.log(`PASS tailnote ${packId}: outputConstraints.tailnote + domainInstructions line + rendered worker prompt all carry the disclaimer`);
}

// ---------------------------------------------------------------------------
// Section 3: switch -> archive -> re-warm roundtrip (software-rd -> target)
// through the real dist http-server, deps-stub pattern from
// tests/test-profile-switch.mjs. banking (all-false capabilities) +
// crossborder-ecom cover both a finance pack and a Phase 3 industry pack
// without looping all six (profile-switch.mjs already owns the exhaustive
// transition matrix).
// ---------------------------------------------------------------------------
const stateMod = await dist("state.js");
const httpMod = await dist("controller/http-server.js");
const { TaskRouter } = await dist("controller/task-router.js");
const { MessageRouter } = await dist("controller/message-router.js");
const { TeamWebSocketServer } = await dist("controller/websocket.js");

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
};
const now = Date.now();

function softwareRdSeedState() {
  return {
    version: 2,
    profileId: "software-rd",
    teamName: "Per-Profile Smoke Team",
    workers: {
      // Offline on purpose (test-profile-switch.mjs scenario-2 note): keeps
      // the drain free of dispatch side effects; the roundtrip semantics do
      // not depend on worker liveness.
      "w-dev": {
        id: "w-dev",
        role: "developer",
        label: "Developer",
        status: "offline",
        transport: "http",
        url: "http://127.0.0.1:9",
        lastHeartbeat: now,
        capabilities: ["coding"],
        registeredAt: now,
      },
    },
    tasks: {
      "task-seed": {
        id: "task-seed",
        title: "Seeded software task",
        description: "Must land in the archive.",
        status: "pending",
        priority: "medium",
        assignedRole: "developer",
        createdBy: "boss",
        createdAt: now,
        updatedAt: now,
      },
    },
    controllerRuns: {},
    projects: {},
    messages: [],
    clarifications: {},
    repo: {
      enabled: true,
      mode: "shared",
      defaultBranch: "main",
      remoteReady: false,
      headCommit: "abc123",
      dirty: false,
      lastPreparedAt: now,
    },
    provisioning: { workers: {} },
    createdAt: now - 5000,
    updatedAt: now,
  };
}

async function runSwitchRoundtrip(targetId) {
  const target = loaderMod.BUILTIN_PROFILES.get(targetId);
  assert.ok(target, `roundtrip target "${targetId}" must be a built-in profile`);

  loaderMod.setActiveProfileId("software-rd");
  fs.rmSync(path.join(stateDir, "archived"), { recursive: true, force: true });
  process.env.TEAMCLAW_WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `tc-pp-smoke-${targetId}-`));

  const config = parsePluginConfig({ mode: "controller", teamName: "Per-Profile Smoke Team", port: 19531, gitEnabled: false });
  let teamState = softwareRdSeedState();
  await stateMod.saveTeamState(teamState);

  // Stub provisioning manager (switch step 5 consumer): records the re-warm
  // dispatch instead of launching processes.
  const warmDispatches = [];
  const workerProvisioningManager = {
    isEnabled: () => true,
    setReconcileSuspended() {},
    hasManagedWorker: () => false,
    async warmRolesForTeamSwitch(roles, reason) {
      warmDispatches.push({ roles: [...roles], reason });
    },
  };

  const wsServer = new TeamWebSocketServer(logger);
  const deps = {
    config,
    logger,
    runtime: {},
    getTeamState: () => teamState,
    updateTeamState: (updater) => {
      updater(teamState);
      void stateMod.saveTeamState(teamState);
      return teamState;
    },
    taskRouter: new TaskRouter(logger),
    messageRouter: new MessageRouter(logger),
    wsServer,
    workerProvisioningManager,
  };
  const server = httpMod.createControllerHttpServer(deps);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, pathname, body) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, json };
  };

  try {
    // The switch itself: 202 + async transition (design section 4).
    const switchRes = await call("POST", "/api/v1/team/profile", { profileId: targetId });
    assert.equal(switchRes.status, 202, `switch to ${targetId} must be accepted`);
    assert.equal(switchRes.json.transition.phase, "draining");

    // Settle poll.
    let settled = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { json } = await call("GET", "/api/v1/team/profile");
      if (json && json.transition === null) {
        settled = json;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(settled, `switch to ${targetId} did not complete within the timeout`);

    // profileId flip + new team identity.
    assert.equal(settled.profileId, targetId, `active profile must flip to ${targetId}`);
    assert.equal(settled.teamName, target.name, `teamName must come from the ${targetId} profile`);

    // Archive: exactly one file, parseable, whole-TeamState + roles snapshot.
    const archivedDir = path.join(stateDir, "archived");
    const files = fs.existsSync(archivedDir) ? fs.readdirSync(archivedDir).sort() : [];
    assert.equal(files.length, 1, `switch to ${targetId}: exactly one archive file`);
    assert.match(files[0], /^software-rd-\d+\.json$/, `archive file name is <sourceProfileId>-<timestamp>.json`);
    const envelope = JSON.parse(fs.readFileSync(path.join(archivedDir, files[0]), "utf8"));
    assert.equal(envelope.profile.id, "software-rd", "archive embeds the SOURCE profile id");
    assert.equal(envelope.profile.roles.length, 11, "archive embeds the full software-rd roles snapshot");
    assert.ok(
      envelope.profile.roles.every((role) => typeof role.systemPrompt === "string" && role.systemPrompt.length > 0),
      "archived roles snapshot keeps systemPrompts",
    );
    assert.ok(envelope.team.tasks["task-seed"], "archive keeps the seeded task");

    // Re-warm dispatch (switch step 5): exactly the target's warmupRoles.
    assert.deepEqual(
      warmDispatches,
      [{ roles: [...target.warmupRoles], reason: `profile switch warmup (${targetId})` }],
      `switch to ${targetId} must dispatch warmRolesForTeamSwitch with the target warmupRoles`,
    );

    // Persisted flip survives to disk.
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "team-state.json"), "utf8"));
    assert.equal(persisted.profileId, targetId, `persisted profileId must be ${targetId}`);
    assert.equal(persisted.teamName, target.name);

    // Capability-disabled routing on the settled all-false target: 404 (never
    // 403) with the owning capability in the error body (design section 4;
    // full matrix in tests/test-capability-gates.mjs).
    const teamautoRes = await call("GET", "/api/v1/teamauto/activity");
    assert.equal(teamautoRes.status, 404, `GET /teamauto/activity must be 404 under ${targetId} (teamauto=false)`);
    assert.equal(teamautoRes.json.capability, "teamauto", "error body names the owning capability");
    assert.equal(teamautoRes.json.profileId, targetId);
    const repoImportRes = await call("POST", "/api/v1/repo/import", {});
    assert.equal(repoImportRes.status, 404, `POST /repo/import must be 404 under ${targetId} (git=false)`);
    assert.equal(repoImportRes.json.capability, "git");

    perPackSummary.push(`${targetId} roundtrip=switch/archive/rewarm+404`);
    console.log(`PASS roundtrip software-rd -> ${targetId}: 202 -> archive(${files[0]}, 11-role snapshot) -> profileId flip -> warmup dispatch [${target.warmupRoles.join(", ")}] -> capability 404s`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    wsServer.close();
  }
}

await runSwitchRoundtrip("banking");
await runSwitchRoundtrip("crossborder-ecom");

// Restore the baseline active profile for anything importing this process later.
loaderMod.setActiveProfileId("software-rd");

console.log(`per-profile smoke passed (${packFiles.length} packs: ${perPackSummary.join("; ")}).`);
