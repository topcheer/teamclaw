# TeamClaw 多行业团队架构设计（TeamProfile）

> 版本 v1.0 · 2026-11-07
> 状态：设计定稿，待评审后按 Phase 实施
> 范围：单实例单团队 + 可切换预置行业团队（软件研发 / 跨境电商 / 贸易 / 银行 / 证券 / 保险 / 自定义）

---

## 0. 摘要

TeamClaw 当前将"软件研发团队"的 11 个角色硬编码在代码中（`src/roles.ts` + `RoleId` 闭集联合类型），controller 层深度耦合 git/GitHub 软件协作流。本设计引入 **TeamProfile（团队配置包）** 抽象：角色集、行业守则、能力开关、工作流模板全部数据化为随包分发的 JSON；一个实例同一时刻激活一个 Profile，可在 UI 中切换（旧团队状态归档，非删除）。软件团队平移为 `software-rd` Profile 作为行为零变化基准。

预计总工作量：核心抽象 + 切换机制 4-5 天，每个行业包 1-2 天（金融类提示词需领域审校），UI/桌面 1-2 天，行业工具集成为按需启动的开放端。

---

## 1. 现状架构（代码级事实，2026-11-07 核查）

### 1.1 角色定义链路

```
src/roles.ts            ROLES: RoleDefinition[]（11 软件角色硬编码，含 systemPrompt/capabilities/suggestedNextRoles）
src/types.ts:67-78      RoleId = "pm" | "architect" | ... | "data-engineer"（TS 闭集联合）
src/types.ts:80-89      RoleDefinition = { id, label, icon, description, capabilities[], recommendedSkills[], systemPrompt, suggestedNextRoles[] }
```

**12 个文件直接 import ROLES / getRole / ROLE_IDS**：

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
| `worker/skill-installer.ts` | 角色推荐技能安装 |

### 1.2 角色自动路由（关键发现：中文盲区）

`role-inference.ts` 按 token 重叠打分：

```ts
role.label.toLowerCase().split(/[^a-z0-9]+/)   // 仅 ASCII 字母数字
text.includes(token)                            // 任务文本子串匹配
```

- 逻辑本身通用（对任意角色列表可打分）✓
- **分词正则丢弃全部 CJK 字符**：中文任务描述（"核保规则调整"）对所有英文 capability token 得 0 分 → 永远 fallback 到 `developer`。今天任何中文任务的自动路由实际上已空转，多行业化前必须修。

### 1.3 软件研发耦合面（controller 层）

| 模块 | 耦合点 | 非软件团队影响 |
|---|---|---|
| `git-collaboration.ts` / `ensureControllerGitRepo` | controller 启动即建 git repo | 银行核保团队无 repo 概念（无害但无用，需按 profile 关） |
| TeamAuto（teamauto sweep） | 定时扫 GitHub 仓库、认领 issue、PR 交付 | 电商/金融团队不适用，需 capability flag 禁用 |
| `preview-manager.ts` | 可运行产物预览（dev server/构建）| 文档交付型团队无"可运行"概念 |
| `delivery-report.ts` / `orchestration-manifest.ts` | 代码审查口径交付报告 | 报告模板需行业化（审查→复核） |
| `openclaw-workspace.ts` / `prompt-policy.ts` | 软件工程规范注入（buildRoleOperatingRules） | 需叠加/替换为行业守则 |

### 1.4 团队状态与 UI

- `TeamState`（types.ts:554+）：teamName / workers / tasks / controllerRuns / projects / messages / clarifications / repo / provisioning / previews / reports / createdAt / updatedAt —— 单实例单团队，无切换语义。
- Web UI 从 `/roles` API 数据驱动渲染（✓ 天然适配多角色集），无团队类型概念。
- 桌面向导写 `mode: controller/worker` + teamName，无团队类型步骤。

---

## 2. 目标架构：TeamProfile

### 2.1 概念模型

```
TeamProfile（团队配置包，JSON，随包分发）
├── id                    "software-rd" | "crossborder-ecom" | "trading-co" | "banking" | "securities" | "insurance" | 自定义 slug
├── name / nameZh         展示名（双语）
├── industry              行业标识（分组用）
├── icon                  emoji
├── version               Profile 版本（升级提示用）
├── description           一句话说明
├── roles[]               RoleDefinition[]（现结构平移，capabilities 双语 token）
│   └── { id, label, labelZh, icon, description, capabilities[], recommendedSkills[], systemPrompt, suggestedNextRoles[] }
├── domainInstructions    行业守则（注入 controller 系统提示：术语规范、合规红线、协作惯例）
├── glossary?             行业术语表（注入 prompt，降低幻觉）
├── workflows[]?          行业工作流模板（预置任务链，见 §2.4）
├── capabilities          软件能力开关：{ git, teamauto, runnablePreview, codeReviewReport }
├── warmupRoles[]         启动预热的角色 id 列表
└── deliverableHints?     交付物预览的行业口径（替代"可运行产物"提示词）
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
└── insurance.json              保险
```

- 内置 Profile 编译进 `dist/src/profiles/`，`/api/v1/profiles` 列出；用户自定义 Profile 放 state 目录 `profiles/`（后续扩展，v1 仅内置）。
- `software-rd.json` 的 systemPrompt 逐字复制现 `roles.ts`（含 developer 的 Deliverable Preview 段），确保平移零漂移。

### 2.3 运行时选择与切换

**配置**（plugin config 新增字段）：

```
teamProfile: string   // 默认 "software-rd"；非法值回退内置并 warn
```

**切换语义（本设计核心决策：归档而非重置）**：

```
POST /api/v1/team/profile { profileId }
  1. 校验 profileId 存在
  2. 停止全部 worker（graceful drain：等 in-flight 任务完成或超时回收）
  3. 归档：TeamState 序列化到 state 目录 archived/<profileId>-<timestamp>.json
     （tasks/clarifications/messages/previews 随旧团队封存，可查不可改）
  4. 新 TeamState：profileId 写入、teamName 更新、清空 workers/tasks/provisioning
  5. 按 warmupRoles 重预热 worker（复用现 worker-provisioning 管道）
  6. UI 全量刷新（/roles /workers /tasks）
```

- 归档而非删除：历史任务/澄清有审计价值（尤其金融行业）。
- 切换需二次确认（UI 弹窗列明"当前团队 N 个任务将归档"）。
- v1 不做同实例多团队并存（用户需求明确单实例单团队）。

### 2.4 行业工作流模板（workflows）

预置任务链，开团队即可用（controller kickoff 的行业化扩展）：

```json
"workflows": [{
  "id": "credit-approval",
  "name": "信贷审批流",
  "steps": [
    { "role": "credit-officer",   "title": "受理与尽调", "outputs": ["尽调报告"] },
    { "role": "risk-reviewer",    "title": "风险审查",   "inputs": ["尽调报告"], "outputs": ["审查意见"] },
    { "role": "approver",         "title": "审批决策",   "inputs": ["审查意见"], "outputs": ["审批结论"] }
  ]
}]
```

UI 呈现为"常用工作流"按钮组，点击向 controller 发 kickoff 指令按 steps 建任务链。

---

## 3. 分层实施计划

### Phase 1 核心抽象（使能层，4-5 天）

| # | 任务 | 要点 | 验收 |
|---|---|---|---|
| 1.1 | `RoleId` 闭集 → branded string | `type RoleId = string & { __roleId: true }`；编译期引用点机械改写（12 文件），运行时由 Profile 校验兜底 | 全仓 `tsc` 零错；现有软件团队行为零变化 |
| 1.2 | Profile 加载器 | `src/profile-loader.ts`：读 JSON → schema 校验 → 缓存；损坏回退 software-rd 并 warn | 单测：合法/缺字段/恶意 id |
| 1.3 | ROLES 调用点改 Profile 注入 | 12 个 import 点改为从"当前激活 Profile"取（http-server / worker-provisioning / prompt-injector / role-inference / task-router / kickoff / identity / contracts / task-executor / worker 两处 / config） | `/roles` 返回 profile 内容 |
| 1.4 | config `teamProfile` 字段 + TeamState.profileId + 存量迁移 | 旧状态默认 software-rd；迁移幂等 | 升级重启无感 |
| 1.5 | software-rd.json 平移 | systemPrompt 逐字复制 roles.ts | golden test：注入 prompt 逐字节等于现状 |

### Phase 2 切换机制与解耦（2-3 天，依赖 P1）

| # | 任务 | 要点 |
|---|---|---|
| 2.1 | 切换端点 + 归档管道 | §2.3 六步；drain 超时强收；归档文件含 profile 元数据 |
| 2.2 | 软件能力 capability flag | git/teamauto/runnablePreview/codeReviewReport 四开关；http-server 路由挂载、controller-service 初始化、preview-manager 按 profile 短路 | banking profile 下 /teamauto/* 404、无 repo 初始化 |
| 2.3 | **role-inference 中文支持** | 分词加 CJK：label/capabilities 双语 token（如 "核保 underwriting"）；匹配加 CJK bigram 子串 | 中文任务描述能路由到正确角色（单测覆盖） |
| 2.4 | domainInstructions 注入 | prompt-injector（controller）与 worker/prompt-injector 管道扩展：行业守则拼装在角色 systemPrompt 之后 | prompt 快照测试 |
| 2.5 | delivery-report 行业口径 | codeReview flag 关闭时报告模板走"复核/审阅"措辞 | 报告样张 |

### Phase 3 行业包（每垂直 1-2 天 + 领域审校，依赖 P1）

六个内置 Profile 的角色集草案（systemPrompt 此处从略，落地时逐个写实，金融三包必须经领域审校后合入）：

**crossborder-ecom 跨境电商**
| 角色 | 职责 |
|---|---|
| sourcing-analyst 选品分析师 | 市场数据选品、竞品分析、利润测算 |
| listing-specialist Listing 优化 | 标题/五点/A+ 页面、关键词 SEO |
| ppc-manager 广告投放 | SP/SB/SD 广告策略、ACOS 优化 |
| cs-lead 客服主管 | 退换货、差评处理、话术库 |
| logistics-specialist 物流专员 | 头程/海外仓、库存周转 |
| compliance-officer 合规专员 | VAT、产品认证、知识产权 |
| store-ops 店铺运营 | 促销活动、账号健康 |
| ecom-analyst 数据分析师 | 销量/广告/库存报表 |

**trading-co 贸易公司**
procurement-manager 采购经理 / documentation-specialist 单证专员（L/C、报关、产地证）/ supply-chain-planner 供应链计划 / settlement-risk-officer 结算风控（汇率、信用证审单）/ market-developer 市场开发 / trade-analyst 贸易数据分析师

**banking 银行**
credit-officer 客户经理（受理尽贷）/ risk-reviewer 风险审查 / approver 审批人 / aml-analyst 反洗钱分析 / compliance-officer 合规官 / bank-product-manager 产品经理（金融产品）/ branch-ops 柜面流程优化

**securities 证券**
industry-researcher 行业研究员 / macro-researcher 宏观研究员 / ibd-associate 投行承做 / securities-compliance 证券合规 / quant-analyst 量化分析（提示词含免责：非投资建议）

**insurance 保险**
underwriter 核保 / claims-adjuster 理赔 / actuary-analyst 精算助理 / insurance-compliance 保险合规 / policy-product 产品设计

**共同要求**：capabilities 双语 token（role-inference 用）；recommendedSkills 只引用技能市场已有技能；warmupRoles 取核心 3-4 角色（成本控制）；金融三包 systemPrompt 加合规免责段落模板。

### Phase 4 行业工具集成（开放端，按客户需求启动）

- Profile 声明 `integrations[]`（如 e-commerce: amazon-sp-api, erp-sync）；controller 按 key 挂载连接器。
- v1 全部行业包 integrations 置空（纯对话/文档流已可用）；具体平台接入按付费需求逐个做（Amazon SP-API、ERP、广告 API、行情源……）。
- **不预建**：无真实客户前接 API 是纯成本。

### Phase 5 UX 与交付（1-2 天）

| # | 任务 |
|---|---|
| 5.1 | Web UI：Settings → 团队切换器（卡片列 /api/v1/profiles，切换弹窗列归档后果与任务数）；工作流模板按钮组 |
| 5.2 | 桌面向导：第 1 步前加"选择团队类型"（六卡 + 图标 + 行业一句话）；选择写入 instance 配置 |
| 5.3 | i18n：角色 labelZh、行业文案、切换弹窗文案 en/zh |
| 5.4 | CI：每 profile 一个冒烟实例（载入→预热→发一条中文任务→断言路由角色正确） |

---

## 4. API 变更汇总

| 端点 | 变更 |
|---|---|
| `GET /api/v1/profiles` | 新增：列出内置 Profile（id/name/icon/industry/description/roleCount） |
| `GET /api/v1/team/profile` | 新增：当前激活 Profile 详情 |
| `POST /api/v1/team/profile` | 新增：切换（§2.3 六步语义） |
| `GET /roles` | 不变路径，返回内容变为激活 Profile 的 roles |
| `GET /api/v1/archived-teams` / `GET /api/v1/archived-teams/:id` | 新增（v1.1，归档只读查询；首版可仅落盘不做查询 UI） |
| `/teamauto/*`、preview 相关 | 存在性随 profile capabilities 变化（禁用时 404） |

## 5. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| RoleId 重构波及 12 文件 | 中 | branded string + tsc 全量兜底 + golden prompt 测试锁行为 |
| role-inference 中文空转（现存 bug，非新风险） | 高 | P2.3 单独修，独立于多行业化交付（今天就能收益） |
| 金融提示词合规责任 | 高 | 免责声明模板 + 领域审校流程（审校人签字记录进 Profile 的 reviewedBy 字段）+ 输出侧不提供监管口径承诺 |
| 切换丢任务感知 | 中 | 归档文件 + 切换弹窗明示任务数；归档可回读 |
| 行业技能引用不存在技能 | 低 | Profile 校验阶段对 recommendedSkills 与技能市场求交集，缺的置空并 warn |
| worker 预热成本（行业角色多） | 低 | warmupRoles 限 3-4 核心；其余按需拉起（现有机制） |

## 6. 决策记录

- **切换 = 归档 + 新建**（不删历史，不做多团队并存）——2026-11-07 定，待用户确认。
- **RoleDefinition 结构平移**（不重定义），仅新增 labelZh 与 capabilities 双语惯例。
- **v1 仅内置 Profile**，自定义 Profile（用户 JSON 上传）留 v2。
- **行业工具集成 P4 按需启动**，不预建。

## 7. 里程碑建议

| 里程碑 | 内容 | 出口标准 |
|---|---|---|
| M1 | P1 全部 + software-rd 平移 | 全部现有测试绿 + golden prompt 零漂移 + 中文路由单测过 |
| M2 | P2 + 首个行业包（建议 crossborder-ecom，无合规风险） | UI 切换 e2e 可演示 |
| M3 | 金融三包 + 审校流程 | reviewedBy 齐 + 合规免责在所有金融 prompt |
| M4 | P5 全量 + 六包 CI 冒烟 | 桌面向导六卡 + 每 profile 冒烟绿 |
