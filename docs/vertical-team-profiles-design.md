# TeamClaw 多行业团队架构设计（TeamProfile）

> 版本 v1.3 · 2026-11-08
> 状态：实施中（Phase 0 已完成，Phase 1 进行中）；v1.2 外部评审修正已并入，v1.3 含实施期勘误（§1.5 TS 5.9 事实 + Phase 1.1 混合 branded 裁决）
> 范围：单实例单团队 + 可切换预置行业团队（软件研发 / 跨境电商 / 贸易 / 银行 / 证券 / 保险 / 自定义）

---

## 0. 摘要

TeamClaw 当前将"软件研发团队"的 11 个角色硬编码在代码中（`src/roles.ts` + `RoleId` 闭集联合类型，且角色清单在仓内另有 6+ 处副本，见 §1.1），controller 层深度耦合 git/GitHub 软件协作流。本设计引入 **TeamProfile（团队配置包）** 抽象：角色集、行业守则、能力开关、工作流模板、输出侧合规约束全部数据化为随包分发的 JSON；一个实例同一时刻激活一个 Profile，可在 UI 中切换（旧团队状态**整份归档**，非删除）。软件团队平移为 `software-rd` Profile 作为行为零变化基准。

预计总工作量（v1.1 修正）：
- Phase 0 现存缺陷独立修复：1-2 天（**不绑多行业化，可先行合入，当天收益**）
- Phase 1 核心抽象 + 唯一事实源收敛：**7-9 天**（含无类型文件与注册表测试重写）
- Phase 2 切换机制与解耦：2-3 天
- Phase 3 行业包：电商/贸易**各 3-4 天**（行话密度最高 + 审校），金融三包各 1-2 天 + 领域审校
- Phase 5 UX 与交付：2-3 天
- Phase 4 行业工具集成：按需启动的开放端（新增零成本"静态知识包"例外，见 §3 Phase 4）

---

## 1. 现状架构（代码级事实，2026-11-07 团队评审复核修正）

> v1.0 §1 的 7 项声称经逐条核实全部属实；但"12 个文件 import ROLES"严重低估实际耦合面，v1.1 补入 §1.1 副本清单与 §1.4 UI 硬编码事实。

### 1.1 角色定义链路与副本清单

```
src/src/roles.ts          ROLES: RoleDefinition[]（11 软件角色硬编码，含 systemPrompt/capabilities/suggestedNextRoles）
src/src/types.ts:67-78    RoleId = "pm" | "architect" | ... | "data-engineer"（TS 闭集联合）
src/src/types.ts:80-89    RoleDefinition = { id, label, icon, description, capabilities[], recommendedSkills[], systemPrompt, suggestedNextRoles[] }
```

**直接依赖 roles.ts 的 12 个 TS 文件（11 个 import ROLES / getRole / ROLE_IDS 三符号 + skill-installer import normalizeRecommendedSkills）**：

| 文件 | 用途 |
|---|---|
| `config.ts` | ROLE_IDS 进配置 schema 校验 |
| `controller/http-server.ts`（257KB） | `/roles` API、任务分配角色校验 |
| `controller/kickoff-orchestrator.ts` | 开局编排按角色建任务 |
| `controller/prompt-injector.ts` | controller 系统提示拼装 |
| `controller/role-inference.ts` | 任务→角色自动路由 |
| `controller/task-router.ts` | 任务派发选角色 |
| `controller/worker-provisioning.ts`（68KB） | worker 预热/供给按角色 |
| `identity.ts` | 实例身份（角色图标/标签） |
| `interaction-contracts.ts` | 角色间交付契约 |
| `task-executor.ts` | worker 执行上下文 |
| `worker/prompt-injector.ts` | worker 系统提示注入 |
| `worker/skill-installer.ts` | 角色推荐技能安装（import 的是 `normalizeRecommendedSkills`，非三符号） |

**v1.0 遗漏：角色清单另有 6+ 处独立硬编码副本（P1 必须一并收敛，否则"两套真相"）**：

| 位置 | 形态 |
|---|---|
| `prompt-policy.ts:5-17` `TEAMCLAW_ROLE_IDS` | 注入 4 段 prompt（:59/:93/:128/:381）——只改 import 点，prompt 里仍是软件 11 角色 |
| `types.ts:880` `VALID_ROLES` | 运行时校验 |
| `controller-tools.ts:49` `VALID_ROLE_IDS` | **只有 10 角色，缺 data-engineer，现存不一致**（Phase 0 顺手修） |
| `openclaw-workspace.ts:526` `TEAMCLAW_ROLE_CATALOG` | workspace 装配目录 |
| `task-executor.ts:17` / `controller/prompt-injector.ts:18` / `worker/prompt-injector.ts:6` | 各自本地 `TEAMCLAW_ROLE_IDS_TEXT` 数组 |
| `openclaw.plugin.json:213,323` | `default:"developer"` + 手写 enum，与 config.ts 双源 |

### 1.2 角色自动路由（关键发现：中文盲区，机制比 v1.0 记载更深）

`role-inference.ts` 打分逻辑：

```ts
token = role.label.toLowerCase().split(/[^a-z0-9]+/)  // CJK 字符本身就是分隔符的一部分，根本不形成 token；`length > 2` 滤掉的是短 ASCII token（如 "qa"）
score += text.includes(token) ? 1 : 0                 // （前瞻：Phase 0.1 加入 CJK token 后，length > 2 将滤掉全部二字中文词，修复须一并放宽——对现状而言中文根本不形成 token）
// 零分返回 null（role-inference.ts:34）；导出的 FALLBACK_ROLE(:41) 是死代码，无任何调用方
```

**developer 兜底实际散在 3 处硬编码**（v1.0 未列全）：
- `worker-provisioning.ts:411` `return ["developer"]`
- `http-server.ts:1927-1928`（developer 默认任务描述三元硬编码）
- `types.ts:643`

→ 今天任何中文任务的自动路由实际空转并被兜到 developer。**修复必须同时覆盖：CJK 分词、`token.length > 2` 过滤、上述 3 处兜底**，只改分词不够。另外并列得分时取数组靠前角色（顺序决定结果而非语义），多行业下须消歧（见 §2.3/P2）。

### 1.3 软件研发耦合面（controller 层）

| 模块 | 耦合点 | 非软件团队影响 |
|---|---|---|
| `git-collaboration.ts` / `ensureControllerGitRepo` | controller 启动即建 git repo（controller-service.ts:65 调用） | 银行核保团队无 repo 概念（无害但无用，需按 profile 关） |
| TeamAuto（teamauto sweep） | 定时扫 GitHub 仓库、认领 issue、PR 交付 | 电商/金融团队不适用，需 capability flag 禁用；**另注意 `teamauto/scanner.ts:27` 角色类型收窄为 `"qa"\|"developer"\|"architect"\|"security-engineer"` 字面量联合、`scheduler.ts:464` 默认 developer/architect——flag 之外还有类型级硬编码** |
| `preview-manager.ts` | 可运行产物预览（web-app/static-site/rest-api 硬口径，:266/:320） | 文档交付型团队无"可运行"概念 |
| `delivery-report.ts` / `orchestration-manifest.ts` / **`interaction-contracts.ts`** | 代码审查口径交付报告 **+ worktree/PR 口径的角色间交付契约** | v1.0 只列了报告，**交付契约是第五个耦合点**，一并开关化（见 §2.1 deliveryReview） |
| `openclaw-workspace.ts` / `prompt-policy.ts` | 软件工程规范注入（buildRoleOperatingRules，:37） | 需明确**替换**语义（非叠加），见 §2.3 决策 |

### 1.4 团队状态与 UI（v1.0 结论修正）

- `TeamState`（types.ts:554-571，另有 `version?` 字段）：teamName / workers / tasks / controllerRuns / projects / messages / clarifications / repo / provisioning / previews / reports / createdAt / updatedAt —— 单实例单团队，无切换语义。
- **状态文件按 teamName 命名持久化**（state.ts:149/161）——切换若改 teamName，旧状态文件残留有碰撞风险，见 §2.3。
- **Web UI 并非纯数据驱动（v1.0"✓ 天然适配"结论不成立）**：`ui/index.html:271-273` 手动任务表单硬编码 `<option>`；`ui/app.js:12` 默认 `"developer"`、:1023 起硬编码图标 map；`desktop/renderer/app.js:62` `externalWorkerRole:'developer'`、:277-281 角色子串→图标；`cli.mjs:42,59-61,1321` 安装向导完整角色表 + developer 兜底。**这些 JS/HTML/JSON 无 tsc 保护，branded string 罩不住，必须纳入 P1 改造范围。**
- 桌面向导写 `mode: controller/worker` + teamName，无团队类型步骤（worker 分支如何感知 profile，v1.0 未写，见 §2.3/P5）。

### 1.5 测试基建

- `tests/test-role-registry.mjs`：对 **15 个文件做文本级正则断言**（含 README.md、docs/index.html、ui/index.html、cli.mjs、plugin.json 必须出现各角色 ID）——**P1 落地必红，v1.0 未列，需同步重写为数据驱动断言**。
- 无 prompt 逐字节 golden 测试，但 node:assert 脚本基建齐全（tests/run-tests.sh、test-worker-contracts 等），golden 可行（P1.7）。
- branded string 可行性已核实：RoleId 未作 Record key、无 switch-case，20+ 处 `as RoleId` 强转与 branded 兼容（建议收敛为单一 `validateRoleId()`，Phase 0）。
- **v1.3 勘误（P1.1 实施时实证）**：上条"字面量可赋 branded"在仓库锁定的 TypeScript 5.9 上**不成立**——TS 5.9 修复 #33050 不健全行为后，字符串字面量不能直接赋给 `string & { __roleId: true }`（严格形态将引爆 57 个编译错，其中 roles.ts 36 处，且与 manifest 生成器的数组字面量 JS 求值、single-source 测试的赋值形态 pin 两条文本契约死锁）。**改用混合形态**：`type RoleId = "pm" | ... | "data-engineer" | (string & { __roleId: true })`——种子联合保留、brand 分支经 validateRoleId 收纳任意 Profile 角色、未知字面量仍被编译器拒绝。已全量验证：编译零错、20 测试与基线字节级同态、防御性探针通过。

---

## 2. 目标架构：TeamProfile

### 2.1 概念模型

```
TeamProfile（团队配置包，JSON，随包分发）
├── id                    "software-rd" | "crossborder-ecom" | "trading-co" | "banking" | "securities" | "insurance" | 自定义 slug
├── name / nameZh         展示名（双语；labelZh 缺失时 UI 回落 label，schema 校验项）
├── industry              行业标识（分组用）
├── icon                  emoji
├── version               Profile 版本（语义化：schema 演进 additive-only，新字段必带默认值）
├── reviewedBy?           领域审校人签字记录（六包必填后才可发布，金融三包硬性要求）
├── description           一句话说明
├── params?               行业参数（如 ecom: { primaryPlatform: "amazon" | "tiktok-shop" | "temu" | "shopify" | "multi" }）
├── roles[]               RoleDefinition[]（结构平移，新增 labelZh；capabilities 双语分层 token，见 §2.3）
│   └── { id, label, labelZh, icon, description, capabilities[], recommendedSkills[], systemPrompt, suggestedNextRoles[] }
├── domainInstructions    行业守则。**语义：非软件 profile 下整体替换 buildRoleOperatingRules（软件规范不注入）；software-rd 下不设此字段（沿用现状）**
├── outputConstraints?    输出侧硬约束（金融三包必填）：
│   ├── tailnote          统一尾注，由 prompt-injector 对全部角色强制拼接（不依赖角色自觉）
│   │                     模板："AI 生成草稿，仅供内部参考，不得作为审批/核保/投资依据或对外报送。"
│   ├── refusals[]        越界拒答清单（如"出具正式审批意见/监管报送文件"→拒绝并转人工）
│   └── citationPolicy    法规引用红线：禁止编造文号/条款号（用户原文提供除外）；glossary 附法规版本截止日
├── glossary?             行业术语表（注入 prompt，降低幻觉；金融包含法规版本截止日声明）
├── workflows[]?          行业工作流模板（带分支语义，见 §2.4）
├── capabilities          软件能力开关：{ git, teamauto, runnablePreview, deliveryReview }
│                         （deliveryReview 泛化 v1.0 的 codeReviewReport，同时覆盖交付报告与
│                          interaction-contracts 的 worktree/PR 交付契约口径）
├── warmupRoles[]         启动预热的角色 id 列表（限核心 3-4 个，成本控制）
├── knowledgePacks[]?     静态知识包（§3 Phase 4 例外清单：随包分发的静态参考数据文件）
└── deliverableHints?     交付物预览的行业口径（替代"可运行产物"提示词；developer systemPrompt
                          内嵌的 previewCommand 语义平移进 software-rd 的该字段）
```

### 2.2 数据布局

```
src/profiles/
├── schema.json                 Profile JSON Schema（校验用，随包分发做运行时校验）
├── software-rd.json            软件研发（现有 11 角色平移，行为零变化基准）
├── crossborder-ecom.json       跨境电商
├── trading-co.json             贸易公司
├── banking.json                银行
├── securities.json             证券
├── insurance.json              保险
└── knowledge/                  静态知识包（按 profile 引用）
    ├── incoterms-2020.md       贸易术语（trading-co）
    ├── hs-refund-snapshot.json HS 编码与出口退税率快照（trading-co）
    └── vat-rates.json          各国 VAT 税率表（crossborder-ecom）
```

- 内置 Profile 编译进 `dist/src/profiles/`，`/api/v1/profiles` 列出；用户自定义 Profile 放 state 目录 `profiles/`（后续扩展，v1 仅内置）。
- `software-rd.json` 的 systemPrompt 逐字复制现 `roles.ts`（含 developer 的 Deliverable Preview 段），确保平移零漂移。
- **Profile 加载器校验失败 = 拒绝启动（fatal）**，不回退 software-rd（v1.0 的"损坏回退并 warn"会把银行团队静默变成软件团队，已废弃该设计）。仅"config 指定的 profileId 不存在"这一种情况允许回退 software-rd 并 warn（引导用户修正配置）。
- **Profile 升级与存量**：schema 演进 additive-only、新字段带默认值；Profile 新版删除角色后，TeamState/warmupRoles 引用被删角色时启动校验 warn + 重路由到最相近角色；归档查询场景靠归档内嵌 roles 快照（§2.3）解决术语漂移。

### 2.3 运行时选择与切换

**单一真相源（v1.1 新增决策，解决三写者冲突）**：

- `TeamState.profileId` 是激活 Profile 的**唯一运行时真相**。
- config `teamProfile` 字段**仅在无 TeamState 的首次初始化时生效**（引导值）；POST 切换只写 TeamState，不回写 config；桌面向导写入的 config 同样只影响首次启动。
- 状态文件命名从 teamName 解耦（改用实例 ID 或 profileId+序号），消除切换后 teamName 变更导致的旧状态文件残留碰撞。

**切换语义（归档而非重置），带 transition 状态机**：

```
POST /api/v1/team/profile { profileId }
  0. 校验 profileId 存在；TeamState 无进行中 transition（否则 409）
  1. 置 transition = { phase: "draining", targetProfileId, startedAt }，广播 WS 事件 team.switch_started
  2. 停止全部 worker（graceful drain：等 in-flight 任务完成或超时强收。**现状无此机制**——worker-provisioning 仅有 terminateManagedWorker 单点终止（"controller shutdown"场景），drain 等待/超时逻辑为新增实现，勿按"复用现管道"理解）
  3. 归档：整份 TeamState 原样序列化到 state 目录 archived/<profileId>-<timestamp>.json，
     并内嵌 profile.roles 快照（防 Profile 升级后归档术语漂移）——tasks/clarifications/messages/
     previews/repo/projects/controllerRuns/reports 随旧团队整体封存，可查不可改
  4. 新 TeamState：profileId/teamName 更新，workers/tasks/provisioning 清空，
     按 capability 省略字段（banking 无 repo/previews/reports）
  5. 按 warmupRoles 重预热 worker（复用现 worker-provisioning 管道），phase: "warming"
  6. 完成后清除 transition，广播 team.switch_completed { profileId }；UI/desktop/存量 worker
     监听事件后拉取 /roles /workers /tasks，worker 按新 profile 重注册
```

**并发与崩溃语义（v1.1 新增）**：

| 事件 | drain/transition 进行中 |
|---|---|
| 再次 POST 切换 | 409 |
| 任务提交 | 503 + Retry-After |
| worker 注册/心跳 | 409，令其退避重试 |
| controller 崩溃重启 | 读到未完成 transition → 按归档文件幂等续作（已归档则跳到新建，未归档则重新 drain） |

- 归档而非删除：历史任务/澄清有审计价值（尤其金融行业）。**v1 即提供 `GET /api/v1/archived-teams`（元数据列表：profileId/teamName/时间/任务数），详情查询 UI 留 v1.1**——没有查询能力的归档不构成审计价值，v1.0 的"归档只落盘、查询全留 v1.1"已修正。
- 切换需二次确认（UI 弹窗列明"当前团队 N 个任务将归档"）。
- v1 不做同实例多团队并存（用户需求明确单实例单团队）。
- **worker 侧感知（v1.0 缺失）**：桌面向导 worker 分支不选 profile（跟随 controller）；独立 worker 通过 `team.switch_started` WS 事件感知切换并按 409 退避，`team.switch_completed` 后按新 profile 重注册。

**role-inference 双语路由（P2 落地，Phase 0 先修 bug 部分）**：

- 分词支持 CJK（label/labelZh/capabilities 双语 token），放宽 `token.length > 2` 对二字中文词的过滤。
- **分层加权**：labelZh 完整词 > 高区分度业务词（如"反洗钱"→aml-analyst、"贷审"→approver）> 泛化词（风险/合规/审查/研究/分析）降权。
- **稀有度规则**：出现于超过 1/3 角色的 bigram 视为停用词（"分析/管理/合规"全员命中等于没命中）。
- **LLM 兜底**：top1/top2 分差低于阈值或全零时，交给 kickoff-orchestrator 既有的 controller LLM pass 判角色（token 打分只做快速路径）。不引入 embedding。
- 消解 v1.0 遗留的"并列取数组靠前"问题：并列且含泛化词命中时也走 LLM 兜底。
- 3 处 developer 硬编码兜底改为"当前 Profile 的 warmupRoles[0] 或 Profile 声明的 defaultRole"。

### 2.4 行业工作流模板（workflows，v1.1 补分支语义）

线性链表达不了信贷审批的常态回退（退回补充材料、提交贷审会），v1.1 改为**带结论分支的声明式结构**（仍不引入完整 DAG）：

```json
"workflows": [{
  "id": "credit-approval",
  "name": "信贷审批流（对公）",
  "steps": [
    { "id": 0, "role": "credit-officer", "title": "受理与尽调",
      "conclusion": ["材料齐全", "需补充材料"],
      "on": { "需补充材料": 0 },
      "outputs": [{ "key": "dueDiligenceReport", "name": "尽调报告" }] },
    { "id": 1, "role": "risk-reviewer", "title": "风险审查",
      "inputs": ["dueDiligenceReport"],
      "conclusion": ["通过", "退回补充材料", "超权限上会"],
      "on": { "退回补充材料": 0, "超权限上会": "committee", "通过": 2 } },
    { "id": 2, "role": "approver", "title": "审批决策",
      "inputs": ["dueDiligenceReport", "reviewOpinion"],
      "outputs": [{ "key": "approvalDecision", "name": "审批结论" }] },
    { "id": "committee", "role": "approver", "title": "贷审会（超权限）",
      "inputs": ["dueDiligenceReport", "reviewOpinion"],
      "outputs": [{ "key": "committeeMinutes", "name": "贷审会纪要式结论" }] }
  ]
}]
```

- `conclusion` 枚举 + `on` 跳转（stepId 或 "next"）；`outputs[].key` 供后续步骤 `inputs` 引用——v1.0 的 inputs/outputs 只是名字字符串、无传递语义，已修。
- controller kickoff 按 steps 建任务链时，把回退边与上游 outputKey 写入后续任务 context。
- UI 呈现为"常用工作流"按钮组，点击向 controller 发 kickoff 指令。

---

## 3. 分层实施计划

### Phase 0 现存缺陷独立修复（1-2 天，先行合入，不绑多行业化）

| # | 任务 | 要点 |
|---|---|---|
| 0.1 | **role-inference 中文修复** | CJK 分词 + 放宽 `token.length > 2` + 3 处 developer 兜底（worker-provisioning.ts:411 / http-server.ts:1927 / types.ts:643）改为可配置兜底 + 中文路由单测（含"核保规则调整"用例）。**现存 bug，今天就能收益** |
| 0.2 | `controller-tools.ts` 补 data-engineer | 消除现存 10/11 角色不一致 |
| 0.3 | `as RoleId` 强转收敛 | 20+ 处收敛为单一 `validateRoleId()`，为 P1 branded string 铺路 |

### Phase 1 核心抽象与唯一事实源收敛（7-9 天，使能层）

| # | 任务 | 要点 | 验收 |
|---|---|---|---|
| 1.1 | `RoleId` 闭集 → **混合 branded**（v1.3 修正） | `type RoleId = "pm" \| ... \| "data-engineer" \| (string & { __roleId: true })`——种子联合保留（TS 5.9 下字面量不可直赋纯 brand，见 §1.5 勘误），brand 分支收纳 Profile 任意角色（经 validateRoleId），未知字面量编译期拒绝；types.ts 单文件改动（G 已全量验证） | 全仓 `tsc` 零错；现有软件团队行为零变化；20 测试与基线同态 |
| 1.2 | **唯一事实源收敛** | §1.1 六处角色副本全部改为从 roles.ts 派生；`openclaw.plugin.json` 的手写 enum 与 config.ts 双源 → 由构建脚本从 roles.ts 生成或启动时一致性校验 | grep 全仓除 roles.ts 与生成物外无角色清单字面量 |
| 1.3 | ROLES 调用点改 Profile 注入 | 12 个依赖点（11 个三符号 import + skill-installer 的 normalizeRecommendedSkills）改为从"当前激活 Profile"取 | `/roles` 返回 profile 内容 |
| 1.4 | **无类型文件数据驱动化**（v1.0 遗漏） | `ui/index.html` 硬编码 option、`ui/app.js` 默认角色与图标 map、`desktop/renderer/app.js`、`cli.mjs` 安装向导角色表 → 从 `/roles`（或 dist profiles JSON）驱动 | bankMock profile 下 UI 向导零软件角色残留（断言测试） |
| 1.5 | **registry 测试重写** | `test-role-registry.mjs` 从 15 文件文本断言改为：角色 ID 唯一性 + 派生一致性 + UI/cli 数据驱动断言 | 新测试绿；人工 profile 可插拔不触发文本断言 |
| 1.6 | config `teamProfile` + TeamState.profileId + 存量迁移 | 单一真相源语义（§2.3）：config 仅首次初始化生效；旧状态默认 software-rd；迁移幂等；状态文件名与 teamName 解耦 | 升级重启无感；切换后重启 profileId 保持 |
| 1.7 | software-rd.json 平移 + golden test | systemPrompt 逐字复制 roles.ts；prompt 逐字节 golden（prompt-injector 两侧） | golden 零漂移 |

### Phase 2 切换机制与解耦（2-3 天，依赖 P1）

> **P1 收官转交的 Phase 2 债务清单**（P1.3 切换时保留的角色表面，v1 软件基线下行为零差异；切换机制落地时逐项处理）：
> ① `controller-tools.ts` VALID_ROLE_IDS 工具入参校验——非软件 profile 会被错杀，须换 `validateActiveRoleId`（P2.1 首项）
> ② `prompt-policy.ts` TEAMCLAW_ROLE_IDS_TEXT（4 段 prompt 规则文本注入）
> ③ `openclaw-workspace.ts` TEAMCLAW_ROLE_CATALOG（模型配置载荷 :750 + 手写 label 表 :545）
> ④ `teamauto/scanner.ts:13` JOINT_REVIEW_ROLES 本地字面量（随 P2.3 scanner 类型收窄一并处理）
> ⑤ `cli.mjs` 安装向导仍读 registry 表（离线安装场景如何感知 profile 待设计决策）
> ⑥ config schema enum 在 `buildConfigSchema()` 求值时对 active profile 的快照时序
> ⑦ 状态恢复分支不回写 `state.teamName`：改名 config 与 state 永久分歧（`/team/status` 出旧名、install 命令出新名）——随切换/归档 wave 处理
> ⑧ `http-server.ts:1910` pm 偏好路由单角色字面量（非清单，记录备查）

| # | 任务 | 要点 |
|---|---|---|
| 2.1 | 切换端点 + transition 状态机 + 归档管道 | §2.3 全语义：drain 超时强收、409/503 并发矩阵、崩溃幂等续作、整份 TeamState + roles 快照归档、v1 归档元数据列表端点 |
| 2.2 | WS 事件契约 | `team.switch_started` / `team.switch_completed { profileId }`；UI/desktop/worker 监听刷新与重注册 |
| 2.3 | capability 开关（4 个） | git / teamauto / runnablePreview / deliveryReview；http-server 路由挂载、controller-service 初始化、preview-manager、delivery-report、**interaction-contracts 交付契约口径**按 profile 短路；teamauto scanner 角色收窄类型一并处理。**UI 契约：`GET /team/profile` 返回 capabilities，UI 据此隐藏入口；后端对禁用能力统一 404（非 403），错误体带 `capability` 字段，CI 断言之**。banking profile 下 /teamauto/* 404、无 repo 初始化 |
| 2.4 | domainInstructions 注入（**替换语义**） | 非软件 profile 下 domainInstructions **整体替换** buildRoleOperatingRules（软件规范不残留）；prompt-injector（controller）与 worker/prompt-injector 管道扩展：行业守则拼装在角色 systemPrompt 之后 | prompt 快照测试（banking prompt 无软件工程规范残留） |
| 2.5 | role-inference 分层加权 + LLM 兜底 | §2.3 完整方案（稀有度停用词、分差阈值、泛化词降权、defaultRole） | 中文任务路由正确 + 误匹配用例（"合规审查""洗钱风险"）进单测 |
| 2.6 | labelZh fallback 校验 | schema：labelZh 缺失时 UI 回落 label，进加载校验 | 断言测试 |

### Phase 3 行业包（依赖 P1；电商/贸易各 3-4 天，金融各 1-2 天 + 领域审校）

> v1.1 修正：角色集按领域评审修订为 v1 最小集；**审校流程扩至全部六包**（客群就是卖家/外贸经理，行话错误直接毁信任，同样落 reviewedBy 字段）；金融三包 systemPrompt 领域审校为硬性合入条件。systemPrompt 落地时逐个写实。

**crossborder-ecom 跨境电商（v1 = 9 角色，职能维度组织；平台差异进 domainInstructions/glossary + params.primaryPlatform，不按平台拆角色）**

| 角色 | 职责（v1.1 修订） |
|---|---|
| sourcing-analyst 选品分析师 | 市场数据选品、竞品分析（**只输出分析框架 + 数据需求清单，禁编造市场数字**） |
| listing-specialist Listing 优化 | **平台多态**：亚马逊五点/A+、TikTok 脚本、独立站文案、关键词 SEO |
| traffic-growth-manager 流量增长（原 ppc-manager 泛化） | 站内广告（SP/SB/SD）+ 红人/联盟营销策略、ACOS 优化 |
| ecom-finance 财务回款（**新增**） | 回款对账、FBA 费用/头程分摊、汇率与资金合规、利润核算 |
| cs-lead 客服主管 | 退换货、差评处理、话术库 |
| logistics-specialist 物流专员 | 头程/海外仓、库存周转 |
| compliance-officer 合规专员 | VAT、产品认证、知识产权、**品牌备案（商标注册+平台备案）** |
| store-ops 店铺运营 | 促销活动、账号健康、店铺绩效 |
| ecom-analyst 数据分析师 | 销量/广告/库存报表解读 |

**trading-co 贸易公司（v1 = 7 角色，v1.1 修订）**

| 角色 | 职责 |
|---|---|
| market-developer 市场开发 | 客户开发、报价谈判 |
| order-merchandiser 跟单员（**新增**） | PI→生产→验货→出运的订单执行 |
| procurement-manager 采购经理 | 采购、**验货安排（QC）** |
| documentation-specialist 单证专员 | HS 归类、产地证（CO/FORM E）、出口退税单证、**UCP600 信用证审单**（审单归此角色）、B/L/箱单/发票 |
| supply-chain-planner 供应链计划 | 排产、物流跟踪 |
| payment-risk-officer 付款风险（原 settlement-risk-officer 聚焦） | 付款方式风险（T/T、D/P、D/A）、欺诈识别、客户资信、出口信保（汇率锁汇归 ecom 类财务职能，已移出） |
| trade-analyst 贸易数据分析师 | 贸易数据解读（禁编造数据） |

**banking 银行（v1 = 6 角色，信贷主线限定对公口径；零售线 v1.1）**

| 角色 | 职责 |
|---|---|
| credit-officer 客户经理 | **对公信贷**受理与尽调（含 AML 名单筛查入口）；押品初评 |
| risk-reviewer 风险审查 | 风险审查（含押品估值口径） |
| approver 审批人 | 审批决策、**贷审会模式**（纪要式结论） |
| aml-analyst 反洗钱分析 | 名单筛查、可疑交易分析 |
| compliance-officer 合规官 | 信贷合规 |
| post-loan-manager 贷后管理（**新增**） | 贷后检查、风险分类提示（贷前-贷中-贷后闭环） |

（branch-ops 柜面流程优化与信贷主线无关，移出 v1，v1.1 再议。）

**securities 证券（v1 缩为研究所 4 角色——研究所+投行+量化同 team 共享上下文违反信息隔离墙制度，v1 不混编）**

| 角色 | 职责 |
|---|---|
| industry-researcher 行业研究员 | 行业研究草稿 |
| macro-researcher 宏观研究员 | 宏观研究草稿 |
| quant-analyst 量化研究（定位为**量化研究/金融工程组**，避免自营暗示） | 因子/策略研究方法学讨论（禁输出具体交易/仓位建议） |
| securities-compliance 证券合规 | 研究合规审查 |

（ibd-associate 投行承做 v1 移除，v1.1 以独立 profile 或硬隔离评估；不加投顾角色——投顾资质边界必被追问。研究草稿输出约束：**不构成证券研究报告、不得对外发布；对外发布须持牌分析师署名复核 + 独立性声明**，写入 outputConstraints。）

**insurance 保险（v1 = 5 角色，underwriter 注明财险或寿险口径二选一）**

| 角色 | 职责 |
|---|---|
| underwriter 核保 | 核保规则（财险/寿险口径声明） |
| claims-adjuster 理赔 | 理赔处理，**systemPrompt 含反欺诈红旗清单** |
| actuary-analyst 精算助理 | **定位：精算文档/方法学助理**（费率说明草拟、偿二代口径解释）；**硬禁输出定价/准备金数字结论**（LLM 编数字在精算场景是事故） |
| insurance-compliance 保险合规 | 保险合规 |
| policy-product 产品设计 | 条款设计辅助 |

（再保险、经代渠道、SIU 反欺诈专岗 v1.1。）

**共同要求（六包）**：
- capabilities 双语分层 token（§2.3 规则，高区分度业务词优先）。
- recommendedSkills 只引用技能市场已有技能，加载时求交集、缺的置空并 warn。
- warmupRoles 取核心 3-4 角色（成本控制）。
- **全部六包经领域审校后合入**，reviewedBy 字段记录签字；金融三包为硬性条件。
- **金融三包 outputConstraints 必填**：统一尾注（prompt-injector 强拼）、越界拒答清单（正式审批意见/监管报送→拒绝转人工）、法规引用红线（禁编文号/条款号）、个保法提示（角色不记录客户身份/账户明文，提示脱敏后粘贴）。
- **无数据不编数字**：ecom/trading 的选品、广告、行情、数据类角色在 domainInstructions 硬约束"不得引用具体市场数据，只输出分析框架 + 数据需求清单"。

### Phase 4 行业工具集成（开放端，按客户需求启动）

- Profile 声明 `integrations[]`（如 e-commerce: amazon-sp-api, erp-sync）；controller 按 key 挂载连接器。
- v1 全部行业包 integrations 置空（纯对话/文档流已可用）；具体平台接入按付费需求逐个做（Amazon SP-API、ERP、广告 API、行情源……）。
- **不预建 API 连接器，但设零成本例外：静态知识包（knowledgePacks）随 Profile 分发**——Incoterms 2020、HS 编码与退税率快照、各国 VAT 税率表等静态参考数据（§2.2 knowledge/ 目录），无运行成本且直接压制行业幻觉。
- **v1 轻量自定义：角色可见性开关**——在内置包基础上勾选隐藏角色 + 改显示名（纯 UI 过滤层，不动 JSON schema），覆盖"删掉没有的岗位、改角色名"这八成自定义需求；完整 JSON 编辑器留 v2。

### Phase 5 UX 与交付（2-3 天）

| # | 任务 |
|---|---|
| 5.1 | Web UI：团队切换器（卡片列 /api/v1/profiles，切换弹窗列归档后果与任务数）；工作流模板按钮组。**入口选型（v1.2 定）：header mini-button + modal，复用 model-settings-modal(:316) 先例——web UI 无 Settings tab，tab 全集仅 7 个（planning/tasks/workspace/clarifications/messages/teamauto/create-task）** |
| 5.2 | 桌面向导：第 1 步前加"选择团队类型"（六卡 + 图标 + 行业一句话）；**worker 分支跳过选择（跟随 controller）**；选择写入 instance 配置（仅首次生效，§2.3） |
| 5.3 | i18n：角色 labelZh、行业文案、切换弹窗文案 en/zh（**不扩语言**；labelZh 缺失回落 label 的规则进 schema）。**双端字典分裂事实：web 侧是 app.js 内联对象（:47 en / :207 zh），desktop 侧是独立 i18n.js 模块——同一 key 两处维护，P5 需盘点对齐或抽公共包** |
| 5.4 | CI：每 profile 一个冒烟实例，断言：载入→预热→发一条中文任务→路由角色正确；**金融包断言免责尾注出现；切换→归档→重预热路径 roundtrip；capability 禁用路由 404 + 错误体 capability 字段** |

---

## 4. API 与事件变更汇总

| 端点/事件 | 变更 |
|---|---|
| `GET /api/v1/profiles` | 新增：列出内置 Profile（id/name/icon/industry/description/roleCount/version/reviewedBy） |
| `GET /api/v1/team/profile` | 新增：当前激活 Profile 详情（**含 capabilities**，UI 据此隐藏入口） |
| `POST /api/v1/team/profile` | 新增：切换（§2.3 transition 语义；进行中 409；返回 202 + WS 事件跟踪） |
| `GET /api/v1/archived-teams` | **新增（v1 即有）**：归档元数据列表（profileId/teamName/时间/任务数）；详情端点与查询 UI 留 v1.1 |
| `GET /roles` | 不变路径，返回内容变为激活 Profile 的 roles |
| `/teamauto/*`、preview、delivery 相关 | 存在性随 profile capabilities 变化（禁用统一 **404**，错误体带 `capability` 字段） |
| WS `team.switch_started` / `team.switch_completed` | 新增：携带 profileId；UI/desktop 刷新、worker 重注册的触发契约 |
| 任务提交（transition 中） | 503 + Retry-After |

## 5. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| RoleId 重构波及面（TS 18-20 文件 + 无类型 7 文件 + registry 测试） | 中 | 唯一事实源先收敛（P1.2）→ branded string → tsc 兜底 + golden prompt 锁行为；无类型文件数据驱动化（P1.4） |
| role-inference 中文空转（现存 bug） | 高 | **Phase 0 独立修复先行**：分词 + length 过滤 + 3 处兜底；P2.5 再加分层加权与 LLM 兜底 |
| profile 三写者/状态文件命名冲突 | 高（已消解） | TeamState.profileId 单一真相；config 仅首次引导；状态文件名与 teamName 解耦（P1.6） |
| 切换并发/崩溃竞态 | 高 | transition 状态机 + 409/503 矩阵 + 归档幂等续作（P2.1） |
| loader 校验失败静默回退 | 高（已消解） | 校验失败 fatal 拒绝启动；仅 profileId 不存在可回退并 warn |
| 金融提示词合规责任 | 高 | outputConstraints 硬约束（尾注强拼/越界拒答/法规引用红线/精算数字禁令/理赔反欺诈）+ 领域审校 reviewedBy 签字 + §2.4 草稿不构成研究报告约束 |
| 证券信息隔离墙 | 高（已消解） | v1 缩为研究所 4 角色；投行 v1.1 独立评估 |
| 无数据编造市场数字 | 高 | ecom/trading 数据类角色 domainInstructions 硬约束 + 静态知识包压幻觉 |
| 行业技能引用不存在技能 | 低 | 加载时与技能市场求交集，缺的置空并 warn |
| worker 预热成本（行业角色多） | 低 | warmupRoles 限 3-4 核心；其余按需拉起（现有机制） |
| Profile schema 演进破坏旧包 | 中 | additive-only + 新字段带默认值；删角色时启动校验 warn + 重路由；归档内嵌 roles 快照 |

## 6. 决策记录

v1.0（2026-11-07 上午）：
- 切换 = 归档 + 新建（不删历史，不做多团队并存）——**已确认（2026-11-07 用户拍板）**。
- RoleDefinition 结构平移（不重定义），新增 labelZh 与 capabilities 双语惯例。
- v1 仅内置 Profile，自定义留 v2。
- 行业工具集成 P4 按需启动，不预建。

v1.3（2026-11-08 实施期裁决）：
- **RoleId 采用混合形态**：`种子 11 字面量联合 | (string & { __roleId: true })`。原设计的纯 branded string 在仓库锁定的 TS 5.9 下不可行（#33050 修复封死字面量直赋通道，严格形态 57 编译错且与 manifest 生成器/ single-source 测试两条文本契约死锁）；混合形态经全量验证达成 P1.1 全部目标（脱离闭集、Profile 角色经 validateRoleId 进入、未知字面量编译期拒绝），零越权改动。裁决人：编排者（Agent G 停工上报触发，探针证据见其实施报告）。

v1.1（2026-11-07 团队评审后）：
- **切换语义「归档 + 新建」经用户确认落定**（解除 v1.0 待确认状态）。
- **TeamState.profileId 为唯一真相**；config `teamProfile` 仅首次初始化生效；状态文件名与 teamName 解耦。
- **loader 校验失败 = fatal**（废弃静默回退 software-rd）。
- **归档 = 整份 TeamState + 内嵌 roles 快照**；v1 即提供归档元数据列表端点（否则审计立论不成立）。
- **切换带 transition 状态机**（draining/archiving/warming）+ WS 事件契约 + 409/503 并发矩阵。
- **capability 四开关**：deliveryReview 泛化 codeReviewReport，一并覆盖 interaction-contracts 交付契约口径。
- **domainInstructions 是替换而非叠加**（非软件 profile 下 buildRoleOperatingRules 不注入）。
- **workflows 补 conclusion/on 分支 + outputKey 传递**（不引入完整 DAG）。
- **中文路由修复拆为 Phase 0 独立先行**（现存 bug，当天收益）。
- **证券 v1 缩为研究所**（信息隔离墙）；banking 补 post-loan-manager、限定对公；trading 补跟单/QC、审单归单证、payment-risk 聚焦；ecom 补财务回款、ppc 泛化 traffic-growth、平台多态。
- **领域审校扩至全部六包**（reviewedBy 必填后才可发布）。
- **金融输出侧硬约束**进 outputConstraints（尾注/拒答/引用红线/数字禁令），prompt-injector 强拼不靠角色自觉。
- **v1 加角色可见性开关**（轻量自定义：隐藏+改名），完整 JSON 自定义留 v2。
- 无数据不编数字硬约束 + 静态知识包（knowledgePacks）作为 P4 零成本例外。

## 7. 里程碑建议

| 里程碑 | 内容 | 出口标准（可测断言） |
|---|---|---|
| M0 | Phase 0 | 中文任务路由单测绿（含 3 处兜底改造）；controller-tools 角色数 = 11 |
| M1 | P1 全部 + software-rd 平移 | 全部现有测试绿（registry 重写后）+ golden prompt 零漂移 + 全仓无角色清单字面量残留（grep 断言）+ UI/cli/plugin.json 数据驱动断言 |
| M2 | P2 + 首个行业包（crossborder-ecom） | **可执行断言**：切换中任务提交得 503；重启后 profileId 保持；归档文件 roundtrip 解析；banking profile 下 /teamauto/* 404 且错误体含 capability；切换 e2e（含 WS 事件） |
| M3 | 金融三包 + 审校流程 | 六包 reviewedBy 齐 + 合规免责尾注在所有金融角色输出冒烟中出现 + outputConstraints 验收 |
| M4 | P5 全量 + 六包 CI 冒烟 | 桌面向导六卡 + worker 分支 + 每 profile 冒烟绿（含误匹配路由用例、归档路径） |

## 8. 修订记录

- **v1.3（2026-11-08）**：实施期勘误与裁决。§1.5 补 TS 5.9 勘误（#33050 修复后字面量不可直赋 branded string，原可行性记录不成立于仓库锁定版本）；Phase 1.1 改为混合 branded 形态（种子联合 | brand），§6 增对应决策记录。触发：Agent G 实施时按纪律停工上报 + 隔离探针证据（57 编译错清单、manifest 生成器 JS 求值约束、single-source 测试形态 pin），替代方案经全量验证后裁决采纳。
- **v1.2（2026-11-07）**：外部评审版（v1.1）三源独立核实后增量修订。核实分工：gg_security（§1.1/§1.2 逐条 grep 复核）、gg_ui（§1.4/Phase5 落点验证）、gg_architect（§1.3 耦合面 + §2.3 切换机制）。v1.1 声称经核实全部属实，修正 8 处：skill-installer 实际 import normalizeRecommendedSkills（非三符号）；CJK 盲区归因精确化（CJK 即分隔符不形成 token，length>2 滤短 ASCII）；role-inference null 返回 :34（原 :38）；http-server 兜底 :1927-1928（原 :1924-1927）；drain 标注"现状无此机制，需新写"（现成仅 terminateManagedWorker 单点终止）；5.1 入口选型落定 header mini-button+modal（web UI 无 Settings tab）；5.3 补 i18n 双端字典分裂事实；§0.1 兜底行号同步。**（同日终审复核：8 处修正逐条对代码再验证全部属实，含 model-settings-modal 实为 index.html:316；另清理 2 处 v1.2 遗留——§1.2 第二行陈旧注释与现状矛盾（中文词过滤是前瞻问题非现状），§1.1 表头/P1.3 的"12 个 import 三符号"计数改为"11+1"口径。）**
- **v1.1（2026-11-07）**：吸收四路团队评审。§1 补入 6+ 处角色副本、registry 测试、UI/desktop/cli 硬编码、role-inference 三处兜底与 length 过滤、teamauto 类型收窄、状态文件命名等 v1.0 遗漏事实；§2 新增单一真相源/transition 状态机/WS 事件/归档 roles 快照/outputConstraints/knowledgePacks/workflows 分支语义，loader 改 fatal；§3 新增 Phase 0，P1 扩容至 7-9 天并纳入无类型文件与测试重写，P3 六包角色集按领域意见修订（对公信贷、贷后、研究所隔离、跟单/QC/审单归属、财务回款、traffic 泛化、平台多态），审校扩至六包；§4 补 WS 事件与 404/503 契约、归档列表提前到 v1；§7 出口标准全部改为可执行断言。
- **v1.0（2026-11-07）**：初稿。
