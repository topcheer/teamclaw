# TeamClaw 架构与设计 Review 报告

> 审阅人: architect-reviewer | 日期: 2025-07-13
> 范围: /Users/zhanju/ggai/teamclaw 全项目架构

---

## 1. 整体架构评估

### 1.1 Controller/Worker 模式评价

TeamClaw 采用经典的 **Controller/Worker 分布式架构**，作为 OpenClaw 插件运行，协调多个 AI agent 实例形成虚拟软件团队。

**架构优点：**

- **职责分离清晰**：Controller 负责任务调度、intake 分析、clarification 管理、Web UI；Worker 负责任务执行。两者通过 HTTP API + WebSocket 通信，物理拓扑灵活。
- **渐进式拓扑**：从单机 process provisioning 到 Docker、Kubernetes，设计文档中明确给出了升级路径，且都已验证。
- **无循环依赖**：Worker 模块不依赖 Controller 模块（仅有一个 `orchestration-manifest.ts` 的类型/normalize 引用），依赖方向是单向的 `controller -> shared <- worker`。
- **插件化集成**：通过 `definePluginEntry` 注册，利用 OpenClaw 的 `registerService`、`registerTool`、`on("before_prompt_build")` 等 hooks 融入宿主运行时。

**架构问题：**

> **[RESOLVED 2026-11-08]** http-server 巨石已消除：7,767 → 360 行组合根（−95.4%），18 个域模块 + 声明式路由表，见 PR #210–#213 与 issue #204。本文件以下描述保留为历史快照。

- **Controller 作为 God Object**：`http-server.ts` (6430 行, 230KB) 承担了过多职责——API 路由、intake 编排、任务管理、状态清理、Preview 代理、报告生成、WebSocket 广播等。它实际上同时充当了 HTTP router、业务逻辑层和数据访问层。
- **缺少明确的领域模型层**：核心业务逻辑（任务生命周期、clarification 流转、项目清理级联）散布在 HTTP handler 内部，没有独立的 domain service 层。
- **状态管理原始**：`TeamState` 是一个纯 JSON 对象，通过 `updateTeamState(updater)` 的 mutable 回调修改，没有事件溯源、快照隔离或变更通知机制。

### 1.2 模块划分评估

```
src/
  index.ts              -- 插件入口，controller/worker 注册分流
  cli.mjs               -- 独立安装器 CLI (1994行)
  src/
    types.ts            -- 全局类型定义 (819行)
    protocol.ts         -- HTTP 工具函数 (96行)
    config.ts           -- 配置 schema + 校验 (365行)
    state.ts            -- 状态持久化 (220行)
    roles.ts            -- 角色定义 (363行)
    task-executor.ts    -- 任务执行器 (1199行)
    prompt-policy.ts    -- Prompt 策略 (393行)
    interaction-contracts.ts -- 契约归一化 (635行)
    git-collaboration.ts    -- Git 协作 (876行)
    openclaw-workspace.ts   -- 工作区路径 (22KB)
    workspace-browser.ts    -- 工作区浏览 (9KB)
    discovery.ts        -- mDNS 发现 (3KB)
    networking.ts       -- 网络工具 (3KB)
    identity.ts         -- Worker 身份 (5KB)
    controller/
      http-server.ts         -- 230KB (!!)
      worker-provisioning.ts -- 64KB
      controller-tools.ts    -- 29KB
      controller-service.ts  -- 14KB
      preview-manager.ts     -- 24KB
      delivery-report.ts     -- 20KB
      kickoff-orchestrator.ts -- 11KB
      prompt-injector.ts     -- 13KB
      orchestration-manifest.ts -- 7KB
      task-router.ts         -- 3KB
      message-router.ts      -- 2KB
      websocket.ts           -- 2KB
      controller-capacity.ts -- 1KB
      role-inference.ts      -- 1KB
      managed-gateway-process.ts -- 8KB
    worker/
      worker-service.ts   -- 10KB
      tools.ts            -- 29KB
      http-handler.ts     -- 7KB
      prompt-injector.ts  -- 2KB
      message-queue.ts    -- 1KB
      skill-installer.ts  -- 10KB
    ui/
      app.js             -- 121KB (前端 SPA)
      index.html         -- 15KB
      style.css          -- 43KB
```

模块划分总体合理，分层为 shared/controller/worker 三层，但粒度不够均匀。controller 子目录已做了进一步拆分（拆出了 preview-manager、delivery-report、kickoff-orchestrator 等），但 **http-server.ts 仍然是系统的结构性瓶颈**。

---

## 2. 依赖关系分析

### 2.1 依赖图

```
index.ts
  ├── src/types.ts (parsePluginConfig, types)
  ├── src/config.ts
  ├── src/state.ts
  ├── src/task-executor.ts
  │   ├── src/roles.ts
  │   ├── src/prompt-policy.ts
  │   └── src/openclaw-workspace.ts
  ├── src/worker/worker-service.ts
  │   ├── src/protocol.ts
  │   ├── src/identity.ts
  │   └── src/worker/http-handler.ts
  │       └── src/protocol.ts
  ├── src/worker/tools.ts
  │   ├── src/interaction-contracts.ts
  │   │   └── src/roles.ts
  │   ├── src/state.ts
  │   └── src/controller/orchestration-manifest.ts  ← 跨层引用
  ├── src/controller/controller-service.ts
  │   ├── src/controller/http-server.ts  ← 核心巨石
  │   ├── src/controller/worker-provisioning.ts
  │   └── ...
  └── src/git-collaboration.ts
```

### 2.2 耦合度评价

| 维度 | 评价 | 说明 |
|------|------|------|
| Controller ↔ Worker | **松耦合 (好)** | 仅通过 HTTP API 交互，无直接代码依赖 |
| Worker → shared | **低耦合 (好)** | Worker 只依赖 types、protocol、state、roles |
| Worker → Controller | **几乎无 (好)** | 仅 `worker/tools.ts` 引用了 `controller/orchestration-manifest.ts` 的 normalize 函数 |
| http-server → 全局 | **高耦合 (问题)** | http-server.ts 直接导入 15+ 模块，承担路由+业务+数据 |
| types.ts → install-defaults.js | **轻微耦合** | 类型文件不应依赖运行时常量，但目前仅一个常量 |
| RoleId 硬编码 | **重复定义 (问题)** | `TEAMCLAW_ROLE_IDS` 在 types.ts、roles.ts、prompt-policy.ts、task-executor.ts、controller-tools.ts、cli.mjs 中各有一份 |

### 2.3 循环依赖

**未发现循环依赖**。依赖流向始终是：
- `index.ts` → 各模块
- `controller/*` → `shared/*`
- `worker/*` → `shared/*`
- 唯一的"反向"引用：`worker/tools.ts → controller/orchestration-manifest.ts`，但这是类型+纯函数，不构成耦合问题。

---

## 3. 可扩展性评估

### 3.1 新增角色

**难度：中等偏低**

- 需要在 `RoleId` union type 中添加新值
- 需要在 `roles.ts` 的 `ROLES` 数组中添加 `RoleDefinition`
- 需要在 `VALID_ROLES` (types.ts)、`TEAMCLAW_ROLE_IDS` (prompt-policy.ts, task-executor.ts)、`VALID_ROLE_IDS` (controller-tools.ts)、`ROLE_OPTIONS` (cli.mjs) 等多处同步更新

**问题**：RoleId 和角色列表分散在 6+ 个位置，缺乏单一数据源 (Single Source of Truth)。应考虑让所有角色列表从 `roles.ts` 的 `ROLES` 数组派生。

### 3.2 新增协议/消息类型

**难度：低**

- `interaction-contracts.ts` 的归一化函数支持新增字段
- `TeamMessageIntent` 等类型是 union type，扩展方便
- API 格式向后兼容（新字段可选）

### 3.3 新增 Provisioning 后端

**难度：低**

- `WorkerProvisionerBackend` 接口清晰：`launch()`、`terminate()`、`stop()`
- 已有 Process、Docker、Kubernetes 三种实现
- 新增后端只需实现接口 + 在 `createProvisionerBackend()` 中注册

### 3.4 新增工具 (Tool)

**难度：低**

- Worker tools 和 Controller tools 都通过 `createWorkerTools()`/`createControllerTools()` 工厂函数注册
- 使用 TypeBox 定义 schema，结构清晰

---

## 4. 配置管理评估

### 4.1 config.ts 设计

**优点：**
- 提供了完整的 JSON Schema 定义，便于 OpenClaw 配置验证
- `parsePluginConfig()` 实现了防御性解析，对每个字段做类型校验和默认值回退
- 支持遗留配置自动升级（如 `workerProvisioningType: "none"` 自动升为 `"process"`）

**问题：**
- `PluginConfig` 类型有 37 个字段，其中 ~25 个是 `workerProvisioning*` 前缀。**配置对象过于扁平**，应考虑嵌套结构：

```typescript
// 当前
type PluginConfig = {
  workerProvisioningType: ...;
  workerProvisioningControllerUrl: ...;
  workerProvisioningRoles: ...;
  workerProvisioningMinPerRole: ...;
  workerProvisioningMaxPerRole: ...;
  // ... 20+ more workerProvisioning* fields
};

// 建议
type PluginConfig = {
  mode: TeamClawMode;
  port: number;
  provisioning?: WorkerProvisioningConfig;  // 独立嵌套
  git?: GitConfig;                           // 独立嵌套
  // ...
};
```

- `parsePluginConfig()` 函数体 ~180 行，与 config.ts 中的 `buildConfigSchema()` 存在**双重维护**问题——schema 默认值和 parser 默认值必须保持一致。

---

## 5. 协议设计评估

### 5.1 types.ts 类型设计

**优点：**
- 类型覆盖全面：从任务状态机 (`TaskStatus` 7 种状态) 到执行事件 (`TaskExecutionEvent`) 到各种契约 (`WorkerTaskResultContract`, `TeamMessageContract` 等)
- 使用 discriminated union 和字面量类型确保类型安全
- `ControllerOrchestrationManifest` 设计良好——controller intake 的输出格式明确，支持任务创建、延迟任务、kickoff 计划等
- `ClarificationQuestionSchema` 支持结构化问答，用户体验友好

**问题：**
- **819 行单文件**：类型、常量 (`VALID_ROLES`, `VALID_PROVISIONING_TYPES`)、运行时解析函数 (`parsePluginConfig`) 混在一个文件中。建议拆分为 `types.ts` (纯类型) + `config.ts` (解析) + `constants.ts`
- **RoleId 硬编码**：union type 中 11 个角色是写死的，新增角色需要修改类型定义

### 5.2 protocol.ts

**简洁且聚焦 (96行)**。仅包含 HTTP 工具函数和消息工厂函数。设计合理。

### 5.3 interaction-contracts.ts

**设计良好 (635行)**。作为 Controller/Worker 之间的"契约层"，负责：
- 归一化从 LLM 输出中提取的结构化契约
- Backfill 缺失字段
- 验证枚举值合法性

这层抽象是对 LLM 输出不确定性的有效防御。

---

## 6. HTTP 服务评估 (http-server.ts)

### 6.1 规模问题

| 指标 | 数值 | 评价 |
|------|------|------|
| 文件大小 | 230KB / 6430 行 | **严重超标** |
| 导入模块数 | 15+ 个 | 过多 |
| API 端点数 | ~30+ | 单文件承载过多 |
| 纯路由逻辑占比 | ~20% | 大量业务逻辑混入 |

### 6.2 职责分析

`http-server.ts` 实际承担的职责包括：

1. **API 路由** (~30 个端点的 if-else 分发)
2. **Controller Intake 编排** (调用 OpenClaw runtime.subagent.run，轮询进度)
3. **任务生命周期管理** (创建、分配、完成、失败、重试、清理)
4. **Clarification 管理** (创建、应答、级联更新)
5. **ControllerRun 管理** (状态机、超时探测、stale 清理)
6. **项目级联删除** (任务→clarification→message→preview→report→文件系统)
7. **Preview 代理** (反向代理到子进程，HTML 重写)
8. **Delivery Report 生成**
9. **WebSocket 事件广播**
10. **Worker 注册/心跳/超时检测**
11. **Git Bundle 导入/导出**
12. **静态文件服务** (Web UI)

### 6.3 拆分建议

```
controller/
  http-server.ts          -- 精简为路由注册入口 (~500行)
  routes/
    team-routes.ts        -- /api/v1/team/* (~200行)
    task-routes.ts        -- /api/v1/tasks/* (~400行)
    worker-routes.ts      -- /api/v1/workers/* (~200行)
    clarification-routes.ts -- /api/v1/clarifications/* (~200行)
    message-routes.ts     -- /api/v1/messages/* (~150行)
    preview-routes.ts     -- /api/v1/previews/* (~300行)
    report-routes.ts      -- /api/v1/reports/* (~150行)
    workspace-routes.ts   -- /api/v1/workspace/* (~200行)
    repo-routes.ts        -- /api/v1/repo/* (~200行)
    static-routes.ts      -- /ui/* 静态文件服务 (~100行)
  services/
    intake-service.ts     -- controller intake 编排 (~800行)
    task-lifecycle.ts     -- 任务状态机 (~600行)
    cleanup-service.ts    -- 级联删除逻辑 (~400行)
    execution-tracker.ts  -- 执行事件追踪 (~300行)
```

---

## 7. Worker 管理评估 (worker-provisioning.ts)

### 7.1 设计评价

**优点：**
- **Backend 接口模式**：`WorkerProvisionerBackend` 接口定义清晰，支持 Process/Docker/Kubernetes 三种实现，可扩展
- **状态机管理**：`ProvisionedWorkerStatus` 有 5 种状态，转换逻辑集中
- **Reconcile 机制**：通过 `reconcile()` 方法确保期望状态与实际状态一致
- **Docker 直接 HTTP API**：不依赖 Docker SDK，直接通过 `/var/run/docker.sock` 调用，减少依赖
- **启动就绪探测**：`StartupProvisioningReadiness` 机制确保系统在 worker 准备好之前不会接受任务

**问题：**
- **1888 行单文件**：包含 Process/Docker/Kubernetes 三种后端实现，应拆分为：
  ```
  worker-provisioning/
    manager.ts            -- WorkerProvisioningManager 核心 (~400行)
    process-backend.ts    -- ProcessProvisioner (~300行)
    docker-backend.ts     -- DockerProvisioner (~600行)
    kubernetes-backend.ts -- KubernetesProvisioner (~400行)
    shared.ts             -- LaunchSpec, LaunchResult 等共享类型 (~100行)
  ```
- **Docker API 调用缺乏重试**：网络波动可能导致 Docker 操作失败
- **进程管理**：`managed-gateway-process.ts` (8KB) 已被拆出，但进程启动的核心逻辑仍在 provisioning 主文件中

---

## 8. 任务执行评估 (task-executor.ts)

### 8.1 设计评价

**优点：**
- **清晰的依赖注入**：`RoleTaskExecutorDeps` 接口定义了运行时、logger、角色、超时、session key 策略等
- **进度轮询**：实现了完善的 session progress 轮询机制，支持 fingerprint 去重、rate limit 检测、子 session 追踪
- **超时探测**：多级超时（inactivity probe、rate limit stall probe、background work probe）
- **结构化 Prompt**：`buildTaskMessage()` 生成包含契约、团队上下文的详细任务 prompt

**问题：**
- **1199 行单函数**：`createRoleTaskExecutor()` 返回的闭包内部逻辑非常复杂，包含了 session 管理、进度追踪、结果解析、事件上报等多个关注点
- **重复的常量定义**：`TOOL_CALL_BLOCK_TYPES`、`RATE_LIMIT_STALL_PROBE_MS` 等在 http-server.ts 中也有定义
- **LLM 输出解析脆弱**：结果契约从 LLM 文本输出中用正则提取，可靠性有限（但这是 LLM 应用的固有限制）

---

## 9. 改进建议 (Top 5)

### P0 (高优先级): 拆分 http-server.ts

**问题**：6430 行的 HTTP 巨石文件是系统最大的架构风险，任何修改都需要理解整个文件的上下文。

**方案**：
1. 提取路由注册为独立文件，按领域分组（task/worker/clarification/message/preview/report/workspace/repo）
2. 提取业务逻辑为 domain service（task-lifecycle、intake-orchestrator、cleanup-service、execution-tracker）
3. http-server.ts 精简为路由注册 + 共享中间件

**收益**：可维护性大幅提升，并行开发无冲突，代码审查范围缩小。

---

### P1 (高优先级): 统一角色定义数据源

**问题**：`RoleId` 和角色列表在 6+ 个文件中重复定义/列举，新增角色时极易遗漏。

**方案**：
1. `roles.ts` 作为唯一角色定义源（已有 `ROLES` 数组）
2. `types.ts` 的 `RoleId` 从 `ROLES` 数组派生
3. `VALID_ROLES`、`TEAMCLAW_ROLE_IDS_TEXT` 等常量统一从 `roles.ts` 导出
4. 消除所有硬编码的角色列表

**收益**：新增角色只需修改一个文件，消除遗漏风险。

---

### P1 (高优先级): 拆分 worker-provisioning.ts

**问题**：1888 行包含三种 provisioning 后端实现，修改一种后端需要在整个文件中导航。

**方案**：按 backend 类型拆分为独立文件，manager 只负责调度和状态管理。

**收益**：独立后端可独立测试和演进。

---

### P2 (中优先级): 配置结构嵌套化

**问题**：`PluginConfig` 37 个扁平字段中 25+ 个是 `workerProvisioning*` 前缀，可读性差。

**方案**：
```typescript
type PluginConfig = {
  mode: TeamClawMode;
  port: number;
  role: RoleId;
  teamName: string;
  git: GitConfig;
  provisioning: ProvisioningConfig;
  agent: AgentConfig;
};
```

**注意**：这是一个 breaking change，需要同步更新 config schema 和 cli.mjs 中的配置写入逻辑。可以设计向后兼容的解析层。

**收益**：配置语义清晰，文档友好，新增配置项不会继续膨胀顶级字段。

---

### P3 (中低优先级): 引入领域服务层

**问题**：任务生命周期、clarification 流转、项目清理级联等核心业务逻辑直接写在 HTTP handler 中，难以测试和复用。

**方案**：
1. 提取 `TaskLifecycleService`：封装任务状态机（创建→分配→执行→完成/失败/重试）
2. 提取 `ClarificationService`：封装 clarification 创建、应答、任务阻塞/恢复逻辑
3. 提取 `ProjectCleanupService`：封装级联删除（已有部分函数，但耦合在 http-server 闭包中）

**收益**：业务逻辑可独立单元测试，HTTP 层变薄，未来更换传输层（如 gRPC）成本低。

---

## 附录：文件规模热力图

```
                          行数
http-server.ts          ████████████████████████████████████████████ 6430
worker-provisioning.ts  ████████████ 1888
cli.mjs                 ████████████ 1994
task-executor.ts        ████████ 1199
interaction-contracts   ████ 635
git-collaboration.ts    ██████ 876
types.ts                █████ 819
preview-manager.ts      ████ 676
controller-tools.ts     ████ 595
prompt-policy.ts        ███ 393
roles.ts                ███ 363
config.ts               ███ 365
controller-service.ts   ██ 371
openclaw-workspace.ts   ██████████████ ~650
```

---

## 总结

TeamClaw 是一个功能完整、设计目标清晰的虚拟团队协调系统。Controller/Worker 架构模式选择正确，模块边界基本合理，无循环依赖，可扩展性良好。

核心架构风险集中在 **http-server.ts 的过度膨胀**，这是所有后续重构的起点。建议按 P0→P1→P2→P3 的优先级逐步推进改进，优先解决代码组织问题，再优化配置结构和领域模型。
