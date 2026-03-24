# TeamClaw 设计文档

## 1. 项目概述

### 1.1 目标

TeamClaw 是 OpenClaw 的一个插件，让多个 OpenClaw 实例组成一个虚拟软件团队，也支持在单个 OpenClaw 实例中通过 `controller + localRoles` 运行本地虚拟团队。各角色通过 Controller/Worker 路由实现任务分配、消息路由和协作工作流。

### 1.2 定位

- **插件 ID**: `teamclaw`
- **插件名称**: TeamClaw
- **宿主**: OpenClaw (通过 `openclaw/plugin-sdk` 接入)
- **代码位置**: `openclaw/extensions/teamclaw/`
- **运行模式**: 本地优先 (local-first)，无需云端服务

### 1.3 核心概念

| 概念 | 说明 |
|------|------|
| **Controller** | 团队管理中心，运行 HTTP 服务器、WebSocket 广播、任务路由和消息路由 |
| **Worker** | 团队成员（一个 OpenClaw 实例），向 Controller 注册后接收任务和消息 |
| **Local Worker** | 由 Controller 在同一 OpenClaw 进程内托管的虚拟 Worker，通过 subagent 执行任务 |
| **Task** | 工作单元，包含标题、描述、优先级、角色指派和状态流转 |
| **Message** | 团队内部消息，支持直接消息、广播和审查请求三种类型 |
| **Role** | 团队角色定义，包含能力标签和系统提示词 |

---

## 2. 系统架构

### 2.1 Controller/Worker 模式

```
                          ┌─────────────────────────────────┐
                          │         Controller              │
                          │  ┌──────────┐  ┌──────────────┐ │
  用户/Agent ─────────────┼─►│ HTTP API │  │  WebSocket   │ │
                          │  │ :9527    │  │  /ws         │ │
                          │  └──────────┘  └──────┬───────┘ │
                          │  ┌──────────┐  ┌──────┴───────┐ │
                          │  │ TaskRouter│  │MessageRouter │ │
                          │  └──────────┘  └──────────────┘ │
                          │  ┌──────────┐  ┌──────────────┐ │
                          │  │ mDNS Ad  │  │ Team State   │ │
                          │  │ vertiser │  │ Persistence  │ │
                          │  └──────────┘  └──────────────┘ │
                          └──────────┬──────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              ┌─────┴─────┐   ┌─────┴─────┐   ┌─────┴─────┐
              │  Worker    │   │  Worker    │   │  Worker    │
              │  (Dev)     │   │  (QA)      │   │  (Arch)    │
              │            │   │            │   │            │
              │ HTTP API   │   │ HTTP API   │   │ HTTP API   │
              │ MessageQ   │   │ MessageQ   │   │ MessageQ   │
              └────────────┘   └────────────┘   └────────────┘
```

在单实例部署时，Controller 仍然保留同样的 API、任务路由和消息路由，只是将部分角色作为 `localRoles` 托管为**本地子 Worker**。这些角色会被 Controller 拉起为独立的 OpenClaw child process：拥有各自隔离的状态目录、HTTP 端口与注册身份，但继续共享同一个 workspace。这样仍保留“单实例”的使用体验，同时把实际 subagent 执行从 Controller 主进程隔离出去，减少活跃任务对 Web UI / API 响应的影响。

### 2.2 通信协议

所有通信基于 HTTP REST API，使用 JSON 格式。WebSocket 用于实时事件推送（仅 Controller 端）。

- **Worker → Controller**: 注册、心跳上报、任务结果提交、消息发送
- **Controller → Worker**: 任务推送 (`POST /api/v1/tasks/assign`)、消息投递 (`POST /api/v1/messages`)
- **Controller → Web UI**: WebSocket 事件广播
- **mDNS**: Worker 自动发现 Controller，Controller 通过 `_teamclaw._tcp` 类型广播

### 2.3 数据流

```
创建任务 → TaskRouter.autoAssign → 推送到 Worker
                                            │
Worker 接收 → 执行 → 报告结果 → Controller 更新状态
                                │
                    WebSocket 广播 → Web UI 刷新
                                │
                    TaskRouter 路由下一任务
```

---

## 3. 模块设计

### 3.1 文件结构

```
extensions/teamclaw/
├── index.ts                          # 插件入口，注册 Controller 或 Worker
├── api.ts                            # OpenClaw 插件 SDK 类型重导出
├── package.json
├── src/
│   ├── types.ts                      # 所有类型定义 + 配置解析
│   ├── config.ts                     # 配置 schema (JSON Schema)
│   ├── roles.ts                      # 10 个角色定义 + 辅助函数
│   ├── state.ts                      # 状态持久化 (读写 JSON)
│   ├── protocol.ts                   # 协议常量、工具函数
│   ├── task-executor.ts              # 共享的角色任务执行器（subagent 封装）
│   ├── discovery.ts                  # mDNS 服务发现 (Advertiser + Browser)
│   ├── identity.ts                   # Worker 身份管理 (IdentityManager)
│   ├── controller/
│   │   ├── controller-service.ts     # Controller 服务生命周期
│   │   ├── http-server.ts            # Controller HTTP 路由 (20+ 端点)
│   │   ├── controller-tools.ts       # Controller Agent 工具 (4 个)
│   │   ├── local-worker-manager.ts   # Controller 托管本地虚拟 Worker
│   │   ├── prompt-injector.ts        # Controller 系统提示词注入
│   │   ├── task-router.ts            # 任务路由算法
│   │   ├── message-router.ts         # 消息路由 (direct/broadcast/review)
│   │   └── websocket.ts              # WebSocket 事件广播
│   ├── worker/
│   │   ├── worker-service.ts         # Worker 服务生命周期
│   │   ├── http-handler.ts           # Worker HTTP 路由 (4 端点)
│   │   ├── tools.ts                  # Worker Agent 工具 (6 个)
│   │   ├── prompt-injector.ts        # Worker 系统提示词注入
│   │   └── message-queue.ts          # Worker 消息队列 (内存, 上限 100)
│   └── ui/
│       ├── index.html                # Web UI 页面
│       ├── app.js                    # Web UI 前端逻辑
│       └── style.css                 # Web UI 样式
```

### 3.2 插件入口 (`index.ts`)

```typescript
definePluginEntry({
  id: "teamclaw",
  name: "TeamClaw",
  description: "Virtual team collaboration...",
  configSchema: buildConfigSchema(),
  register(api: OpenClawPluginApi) {
    const config = parsePluginConfig(api.pluginConfig);
    if (config.mode === "controller") {
      registerController(api, config);
    } else {
      registerWorker(api, config);
    }
  },
});
```

根据 `config.mode` 分流：
- **Controller 模式**: 注册 Service + PromptInjector + Tools；当配置 `localRoles` 时，同时托管本地子 Worker 生命周期（spawn / restart / shared-workspace wiring）
- **Worker 模式**: 注册 Service + PromptInjector + Tools + MessageQueue

### 3.3 类型定义 (`types.ts`)

导出所有核心类型：

| 类型 | 用途 |
|------|------|
| `TeamClawMode` | `"controller" \| "worker"` |
| `WorkerStatus` | `"idle" \| "busy" \| "offline"` |
| `TaskStatus` | `"pending" \| "assigned" \| "in_progress" \| "review" \| "blocked" \| "completed" \| "failed"` |
| `TaskPriority` | `"low" \| "medium" \| "high" \| "critical"` |
| `RoleId` | 10 个角色 ID 的联合类型 |
| `RoleDefinition` | 角色完整定义（标签、能力、提示词、建议后续角色） |
| `WorkerInfo` | Worker 运行时状态（含 `transport: "http" \| "local"`） |
| `TaskInfo` | 任务完整信息 |
| `TeamMessage` | 消息（支持 direct/broadcast/review-request） |
| `ClarificationRequest` | 人类澄清请求与答复状态 |
| `PluginConfig` | 插件配置（含 `localRoles`、`taskTimeoutMs`） |
| `WorkerIdentity` | Worker 注册身份 |
| `TeamState` | 团队全局状态 |
| `RegistrationRequest` | Worker 注册请求体 |
| `HeartbeatPayload` | 心跳请求体 |
| `DiscoveryResult` | mDNS 发现结果 |

`parsePluginConfig()` 函数解析原始配置，提供默认值验证；其中 `taskTimeoutMs` 默认值为 30 分钟，用于控制单个角色任务的最长执行等待时间。

运行时还存在一层 OpenClaw agent 自身的 timeout（`agents.defaults.timeoutSeconds`）。如果该值小于 TeamClaw 的 `taskTimeoutMs / 1000`，则内层 agent 会先超时，导致 TeamClaw 任务被提前打断。因此真实长链路 practical / benchmark 环境应把两者一起调大，并确保 OpenClaw 侧 timeout 不小于 TeamClaw 侧。

`TeamState` 还持久化 `clarifications` 队列：当角色因缺少关键信息而无法安全推进时，任务会转为 `blocked`，并由 Controller 统一等待人类答复。

当前 TeamClaw task 更偏向“正在流转的 live work item”，而不是带完整依赖语义的 backlog placeholder。因此 Controller 在 intake 或规划阶段应只创建**已满足前置条件、可以立即启动**的任务；对未来阶段先保留为分析结论或计划说明，等前置结果产出后再物化成新任务。对于由 Controller intake 创建出来的任务链，当前实现会在该任务完成后再次进入同一条 intake 会话，让 Controller 基于最新完成产物继续判断是否需要创建下一阶段的 execution-ready task，而不是把整个流程停在第一张任务卡上。

对基础设施与外部工具同样适用上述规则：若 Infra / DevOps 在当前运行环境中拿不到所需的 Docker / Kubernetes / 凭据 / 外部服务接入，或者只有商业/专有方案才能继续，必须把任务保持为 `blocked` 并请求人类澄清；默认优先采用开源/免费方案。

### 3.4 角色系统 (`roles.ts`)

导出：
- `ROLES`: `RoleDefinition[]` — 10 个角色的完整定义数组
- `ROLE_IDS`: `RoleId[]` — 所有角色 ID
- `getRole(id)`: 按 ID 获取角色定义
- `buildRolePrompt(role, teamContext?)`: 构建角色的系统提示词

### 3.5 状态持久化 (`state.ts`)

导出：
- `STATE_DIR`: `~/.openclaw/plugins/teamclaw/`
- `loadTeamState(teamName)`: 加载团队状态，含基础校验
- `saveTeamState(state)`: 保存团队状态（自动更新 `updatedAt`）
- `loadWorkerIdentity()` / `saveWorkerIdentity()` / `clearWorkerIdentity()`: Worker 身份持久化

### 3.6 协议工具 (`protocol.ts`)

常量：
- `MDNS_TYPE`: `"_teamclaw._tcp"`
- `DEFAULT_PORT`: `9527`
- `HEARTBEAT_MS`: `10000`
- `WORKER_TIMEOUT_MS`: `30000`
- `API_PREFIX`: `"/api/v1"`

函数：
- `generateId()`: 生成唯一 ID（时间戳 base36 + 随机字符串）
- `parseJsonBody(req)`: 解析 HTTP 请求体为 JSON
- `sendJson(res, status, data)`: 发送 JSON 响应（含 CORS 头）
- `sendError(res, status, message)`: 发送错误响应
- `createRegistrationRequest(...)`: 构建注册请求体
- `createHeartbeatPayload(...)`: 构建心跳请求体

### 3.7 服务发现 (`discovery.ts`)

- `MDnsAdvertiser`: 在 Controller 端发布 mDNS 服务，类型 `_teamclaw._tcp`，包含 `teamName` TXT 记录
- `MDnsBrowser`: 在 Worker 端浏览 mDNS 发现 Controller（超时默认 5 秒，找到首个结果即停止）

### 3.8 身份管理 (`identity.ts`)

`IdentityManager` 类负责 Worker 的注册和身份生命周期：

1. 优先从磁盘恢复已有身份 (`loadWorkerIdentity`)
2. 如无已有身份，通过 mDNS 发现 Controller URL（失败则用 `config.controllerUrl` 回退）
3. 生成 `workerId`，调用 `POST /api/v1/workers/register` 注册
4. 注册成功后持久化身份到磁盘
5. `clear()` 时通知 Controller 删除 Worker 记录

### 3.9 Controller 模块

#### controller-service.ts

服务生命周期管理：
- `start()`: 加载/创建 TeamState → 同步 `localRoles` 到团队状态 → 启动 mDNS 广播 → 启动 HTTP 服务器 → 启动超时监控（每 15 秒检查远程 Worker 心跳，超时 30 秒标记 offline）
- `stop()`: 清理定时器、关闭 WebSocket、停止 mDNS

#### http-server.ts

路由所有 Controller 端点（详见第 5 节）。同时挂载 WebSocket 服务（路径 `/ws`），并统一处理远程 HTTP Worker 与本地虚拟 Worker 的任务派发、消息投递和结果回收。

#### task-router.ts

`TaskRouter` 实现三级任务路由策略：
1. **精确角色匹配**: 按 `task.assignedRole` 找空闲 Worker
2. **能力关键词匹配**: 从任务描述提取关键词，与 Worker 角色的 `capabilities` 做模糊匹配，按匹配数排序
3. **兜底分配**: 任意空闲 Worker

`autoAssignPendingTasks()` 批量自动分配未指派的任务。

#### message-router.ts

`MessageRouter` 支持三种路由：
- `routeDirectMessage()`: 按 `toRole` 找到在线 Worker 投递
- `routeBroadcast()`: 投递给所有在线 Worker（排除发送者自身）
- `routeReviewRequest()`: 复用 `routeDirectMessage` 的逻辑

#### websocket.ts

`TeamWebSocketServer` 基于 `ws` 库，挂载到 HTTP 服务器的 `/ws` 路径。支持广播 6 种事件类型。

#### prompt-injector.ts

Controller 端的 `before_prompt_build` 钩子，向 Agent 的系统提示词注入：
- 团队模式说明
- 原始人类输入 = 需求入口，Controller 先做需求分析与澄清
- 可用工具列表
- 当前 Worker 列表及状态
- 任务统计和待处理任务
- 可用角色列表
- 控制纪律：需求明确后再派工，不把未分析的原始需求直接丢给 Worker

### 3.10 Worker 模块

#### worker-service.ts

服务生命周期管理：
- `start()`: 创建 MessageQueue → 启动 HTTP 服务器 → 注册到 Controller → 启动心跳定时器
- 心跳期间，如未注册则持续尝试注册
- `stop()`: 清理定时器、关闭服务器、清除身份

#### http-handler.ts

处理 Worker 端 4 个 HTTP 端点（详见第 5 节）。
提供 `TaskExecutor` 和 `ResultReporter` 回调类型，用于集成 Agent 任务执行。

#### message-queue.ts

`MessageQueue` 类：
- 内存队列，最大 100 条消息
- `push()`: 入队（超出上限时截断旧消息）
- `drain()`: 取出并清空所有消息
- `peek()`: 查看但不移除
- `clear()`: 清空

#### prompt-injector.ts

Worker 端的 `before_prompt_build` 钩子，向 Agent 注入：
- 角色上下文（角色标签 + 系统提示词）
- Worker ID 和 Controller URL
- 待处理的团队消息队列

---

## 4. 配置参考

### 4.1 插件配置

通过 OpenClaw 的 `openclaw.json` 中的 `plugins.teamclaw` 配置：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `mode` | `"controller" \| "worker"` | `"worker"` | 运行模式 |
| `port` | number | `9527` | HTTP 服务器端口 |
| `role` | string | `"developer"` | Worker 角色（仅 worker 模式） |
| `controllerUrl` | string | `""` | 手动指定 Controller URL（mDNS 失败时回退） |
| `teamName` | string | `"default"` | 团队名称（用于 mDNS 标识） |
| `heartbeatIntervalMs` | number | `10000` | 心跳间隔（毫秒），最小值 1000 |
| `localRoles` | `RoleId[]` | `[]` | Controller 模式下在同实例内托管的本地虚拟 Worker 角色列表 |

### 4.2 协议常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `MDNS_TYPE` | `_teamclaw._tcp` | mDNS 服务类型 |
| `DEFAULT_PORT` | 9527 | 默认端口 |
| `HEARTBEAT_MS` | 10000 | 默认心跳间隔 |
| `WORKER_TIMEOUT_MS` | 30000 | Worker 超时判定 |
| `API_PREFIX` | `/api/v1` | API 路径前缀 |

### 4.3 状态文件路径

| 文件 | 路径 | 说明 |
|------|------|------|
| 团队状态 | `~/.openclaw/plugins/teamclaw/{teamName}-team-state.json` | 包含 workers、tasks、messages |
| Worker 身份 | `~/.openclaw/plugins/teamclaw/worker-identity.json` | 包含 workerId、role、controllerUrl |

---

## 5. REST API 参考

所有端点前缀为 `/api/v1`。响应均为 JSON 格式，含 CORS 头。

### 5.1 Controller 端点

#### Worker 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/workers/register` | 注册 Worker |
| `DELETE` | `/workers/:id` | 移除 Worker |
| `GET` | `/workers` | 列出所有 Worker |
| `POST` | `/workers/:id/heartbeat` | Worker 心跳 |

**POST /workers/register**

请求体：
```json
{
  "workerId": "string (必填)",
  "role": "RoleId (必填)",
  "label": "string",
  "url": "string (必填)",
  "capabilities": "string[]"
}
```

响应 `201`:
```json
{
  "status": "registered",
  "worker": { "WorkerInfo" }
}
```

**POST /workers/:id/heartbeat**

请求体：
```json
{
  "status": "WorkerStatus",
  "currentTaskId": "string (可选)"
}
```

响应 `200`:
```json
{ "status": "ok" }
```

#### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/tasks` | 创建任务（自动分配） |
| `GET` | `/tasks` | 列出所有任务 |
| `GET` | `/tasks/:id` | 获取任务详情 |
| `PATCH` | `/tasks/:id` | 更新任务 |
| `POST` | `/tasks/:id/assign` | 分配任务 |
| `POST` | `/tasks/:id/handoff` | 转交任务 |
| `POST` | `/tasks/:id/result` | 提交任务结果 |

**POST /tasks**

请求体：
```json
{
  "title": "string (必填)",
  "description": "string",
  "priority": "TaskPriority (默认 medium)",
  "assignedRole": "RoleId (可选)",
  "createdBy": "string (默认 boss)"
}
```

响应 `201`:
```json
{
  "task": { "TaskInfo" }
}
```

创建后自动调用 `TaskRouter.autoAssignPendingTasks()`，如匹配到 Worker 则推送任务并返回 `assigned` 状态。

**PATCH /tasks/:id**

请求体（所有字段可选）：
```json
{
  "status": "TaskStatus",
  "progress": "string",
  "priority": "TaskPriority",
  "assignedRole": "RoleId"
}
```

**POST /tasks/:id/assign**

请求体：
```json
{
  "workerId": "string (可选，省略则自动路由)",
  "targetRole": "RoleId (可选，用于按角色重新路由)"
}
```

响应 `200`:
```json
{
  "task": { "TaskInfo" },
  "worker": { "id": "string", "label": "string" }
}
```

**POST /tasks/:id/handoff**

请求体：
```json
{
  "targetRole": "RoleId (可选)"
}
```

将任务状态重置为 `pending`，释放原 Worker，尝试自动分配到新角色；若新角色无可用 Worker，则任务保留为待处理状态。

**POST /tasks/:id/result**

请求体：
```json
{
  "result": "string",
  "error": "string (可选)"
}
```

提交后任务状态变为 `completed` 或 `failed`，释放关联 Worker。

#### 消息路由

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/messages/direct` | 发送直接消息 |
| `POST` | `/messages/broadcast` | 广播消息 |
| `POST` | `/messages/review-request` | 请求代码审查 |
| `GET` | `/messages` | 获取消息列表 |

**POST /messages/direct**

请求体：
```json
{
  "from": "string",
  "fromRole": "RoleId",
  "toRole": "RoleId (必填)",
  "content": "string",
  "taskId": "string (可选)"
}
```

响应 `201`:
```json
{
  "status": "delivered" | "no-target",
  "message": { "TeamMessage" }
}
```

**POST /messages/broadcast**

请求体：
```json
{
  "from": "string",
  "fromRole": "RoleId",
  "content": "string",
  "taskId": "string (可选)"
}
```

响应 `201`:
```json
{
  "status": "broadcast",
  "recipients": "number"
}
```

**POST /messages/review-request**

请求体与 direct 消息相同，`type` 自动设为 `"review-request"`。

**GET /messages**

查询参数：
- `limit`: 返回条数上限（默认 50）
- `offset`: 偏移量（默认 0）

响应 `200`:
```json
{
  "messages": [{ "TeamMessage" }],
  "total": "number"
}
```

#### 团队信息

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/team/status` | 团队状态 |
| `GET` | `/roles` | 角色列表 |
| `GET` | `/health` | 健康检查 |

**GET /team/status**

响应 `200`:
```json
{
  "teamName": "string",
  "workers": [{ "WorkerInfo" }],
  "tasks": [{ "TaskInfo" }],
  "messages": [{ "TeamMessage" }],
  "taskCount": "number",
  "workerCount": "number"
}
```

**GET /health**

响应 `200`:
```json
{
  "status": "ok",
  "mode": "controller",
  "timestamp": "number"
}
```

### 5.2 Worker 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/v1/health` | Worker 健康检查 |
| `POST` | `/api/v1/tasks/assign` | 接收任务分配 |
| `POST` | `/api/v1/messages` | 接收消息 |
| `GET` | `/api/v1/messages` | 取出待处理消息 |

**GET /api/v1/health**

响应 `200`:
```json
{
  "status": "ok",
  "workerId": "string",
  "role": "RoleId",
  "timestamp": "number"
}
```

**POST /api/v1/tasks/assign**

请求体：
```json
{
  "taskId": "string (必填)",
  "title": "string (必填)",
  "description": "string (必填)",
  "priority": "TaskPriority"
}
```

响应 `202`:
```json
{
  "status": "accepted",
  "taskId": "string"
}
```

**POST /api/v1/messages**

请求体为 `TeamMessage` 对象。响应 `201`:
```json
{ "status": "queued" }
```

**GET /api/v1/messages**

响应 `200`（drain 语义，取出后清空队列）：
```json
{
  "messages": [{ "TeamMessage" }]
}
```

---

## 6. WebSocket 事件

WebSocket 服务挂载在 Controller HTTP 服务器的 `/ws` 路径。

所有事件为 JSON 格式：
```json
{
  "type": "事件类型",
  "data": { /* 事件数据 */ }
}
```

### 6.1 事件类型

| 事件类型 | 触发时机 | data 内容 |
|---------|---------|-----------|
| `worker:online` | Worker 注册成功 | `{ "WorkerInfo" }` |
| `worker:offline` | Worker 超时或被移除 | `{ "workerId": "string" }` |
| `task:created` | 新任务创建 | `{ "TaskInfo" }` |
| `task:updated` | 任务状态/分配变更 | `{ "TaskInfo" }` |
| `task:completed` | 任务完成或失败 | `{ "TaskInfo" }` |
| `message:new` | 新消息产生 | `{ "TeamMessage" }` |

Web UI 连接 WebSocket 后，收到任意事件都会调用 `refreshAll()` 重新拉取完整状态。

---

## 7. Agent 工具

### 7.1 Controller 工具（4 个）

通过 `api.registerTool()` 注册，提供给 Controller 端的 OpenClaw Agent 使用。

#### teamclaw_create_task

创建新任务，自动尝试分配。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 是 | 任务标题 |
| `description` | string | 是 | 详细任务描述 |
| `priority` | string | 否 | 优先级: low/medium/high/critical |
| `assignedRole` | string | 否 | 目标角色 ID |

Schema:
```typescript
Type.Object({
  title: Type.String({ description: "Task title" }),
  description: Type.String({ description: "Detailed task description" }),
  priority: Type.Optional(Type.String({ description: "Priority: low, medium, high, critical" })),
  assignedRole: Type.Optional(Type.String({ description: "Target role (e.g., developer, qa, architect)" })),
})
```

#### teamclaw_list_tasks

列出任务，支持状态过滤。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | 否 | 过滤状态: pending/assigned/in_progress/review/completed/failed |

Schema:
```typescript
Type.Object({
  status: Type.Optional(Type.String({ description: "Filter by status: pending, assigned, in_progress, review, completed, failed" })),
})
```

#### teamclaw_assign_task

分配任务到指定 Worker 或自动路由。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 任务 ID |
| `workerId` | string | 否 | 指定 Worker ID（省略则自动路由） |

Schema:
```typescript
Type.Object({
  taskId: Type.String({ description: "Task ID to assign" }),
  workerId: Type.Optional(Type.String({ description: "Specific worker ID (omit for auto-routing)" })),
})
```

#### teamclaw_send_message

发送直接消息或广播。不指定 `toRole` 则广播。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | 是 | 消息内容 |
| `toRole` | string | 否 | 目标角色（省略则广播） |
| `taskId` | string | 否 | 关联任务 ID |

Schema:
```typescript
Type.Object({
  content: Type.String({ description: "Message content" }),
  toRole: Type.Optional(Type.String({ description: "Target role for direct message (omit for broadcast)" })),
  taskId: Type.Optional(Type.String({ description: "Related task ID" })),
})
```

### 7.2 Worker 工具（6 个）

提供给 Worker 端的 OpenClaw Agent 使用。

#### teamclaw_ask_peer

向其他角色提问。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `targetRole` | string | 是 | 目标角色 |
| `question` | string | 是 | 问题内容 |
| `taskId` | string | 否 | 关联任务 ID |

Schema:
```typescript
Type.Object({
  targetRole: Type.String({ description: "Target role (e.g., architect, qa, pm)" }),
  question: Type.String({ description: "The question to ask" }),
  taskId: Type.Optional(Type.String({ description: "Related task ID if any" })),
})
```

#### teamclaw_broadcast

向所有团队成员广播消息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 广播内容 |
| `taskId` | string | 否 | 关联任务 ID |

Schema:
```typescript
Type.Object({
  message: Type.String({ description: "The message to broadcast" }),
  taskId: Type.Optional(Type.String({ description: "Related task ID if any" })),
})
```

#### teamclaw_request_review

请求特定角色进行审查。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `targetRole` | string | 是 | 审查目标角色 |
| `reviewContent` | string | 是 | 需要审查的内容 |
| `taskId` | string | 是 | 关联任务 ID |

Schema:
```typescript
Type.Object({
  targetRole: Type.String({ description: "Role to request review from" }),
  reviewContent: Type.String({ description: "Content to review or description of what needs review" }),
  taskId: Type.String({ description: "Related task ID" }),
})
```

#### teamclaw_suggest_handoff

建议将任务移交给其他角色。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 任务 ID |
| `targetRole` | string | 是 | 移交目标角色 |
| `reason` | string | 是 | 移交原因 |

Schema:
```typescript
Type.Object({
  taskId: Type.String({ description: "Task ID to hand off" }),
  targetRole: Type.String({ description: "Role to hand off to" }),
  reason: Type.String({ description: "Reason for the handoff" }),
})
```

#### teamclaw_get_team_status

获取团队当前状态，无需参数。

Schema:
```typescript
Type.Object({})
```

#### teamclaw_report_progress

报告任务进度。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `taskId` | string | 是 | 任务 ID |
| `progress` | string | 是 | 进度描述 |
| `status` | string | 否 | 新状态: in_progress/review/completed/failed |

Schema:
```typescript
Type.Object({
  taskId: Type.String({ description: "Task ID" }),
  progress: Type.String({ description: "Progress update message" }),
  status: Type.Optional(Type.String({ description: "New status: in_progress, review, completed, failed" })),
})
```

---

## 8. 角色系统

### 8.1 角色定义

| Role ID | 标签 | 图标 | 描述 | 能力 |
|---------|------|------|------|------|
| `pm` | Product Manager | 📋 | 产品规划、需求分析、用户故事 | requirements-analysis, user-stories, product-specification, priority-planning, stakeholder-communication |
| `architect` | Software Architect | 🏗️ | 系统设计、技术架构、API 设计 | system-design, api-design, database-schema, technology-selection, code-review-architecture |
| `developer` | Developer | 💻 | 代码实现、Bug 修复、功能开发 | coding, debugging, feature-implementation, code-refactoring, unit-testing |
| `qa` | QA Engineer | 🔍 | 测试、质量保证、Bug 报告 | test-planning, test-case-writing, bug-reporting, regression-testing, quality-assurance |
| `release-engineer` | Release Engineer | 🚂 | 发布管理、部署、版本控制 | release-management, deployment, version-control, ci-cd-pipeline, release-notes |
| `devops` | DevOps Engineer | ⚙️ | 基础设施、CI/CD、监控 | infrastructure, ci-cd, monitoring, docker-kubernetes, automation |
| `designer` | UI/UX Designer | 🎨 | 用户界面设计、UX 研究、线框图 | ui-design, ux-research, wireframing, prototyping, design-systems |
| `marketing` | Marketing Specialist | 📣 | 产品营销、内容、发布策略 | product-marketing, content-creation, launch-strategy, user-acquisition, analytics |

### 8.2 角色流转建议

每个角色定义了 `suggestedNextRoles`，用于任务转交建议：

| 角色 | 建议下一角色 |
|------|-------------|
| pm | architect, designer |
| architect | developer, devops |
| developer | qa, developer |
| qa | developer, release-engineer |
| release-engineer | devops, developer |
| devops | developer, release-engineer |
| designer | developer, pm |
| marketing | pm, designer |

### 8.3 能力与任务路由

任务路由器 (`TaskRouter`) 使用角色的 `capabilities` 数组做关键词匹配。例如，任务描述包含 "API design" 时，会优先匹配 `architect` 角色（因其 capabilities 包含 `api-design`）。

角色 prompt 还额外约束了执行纪律：团队成员不能私自扩张 backlog、不能在缺少关键信息时猜测，且在 infra/tooling 不可用时必须通过 clarification 回到人类，而不是旁路创建一套虚假的环境。

---

## 9. 状态持久化

### 9.1 文件格式

**团队状态** (`{teamName}-team-state.json`):
```json
{
  "teamName": "default",
  "workers": {
    "<workerId>": {
      "id": "string",
      "role": "RoleId",
      "label": "string",
      "status": "WorkerStatus",
      "url": "string",
      "lastHeartbeat": "number (timestamp)",
      "capabilities": ["string"],
      "currentTaskId": "string (可选)",
      "registeredAt": "number (timestamp)"
    }
  },
  "tasks": {
    "<taskId>": {
      "id": "string",
      "title": "string",
      "description": "string",
      "status": "TaskStatus",
      "priority": "TaskPriority",
      "assignedRole": "RoleId (可选)",
      "assignedWorkerId": "string (可选)",
      "createdBy": "string",
      "createdAt": "number",
      "updatedAt": "number",
      "startedAt": "number (可选)",
      "completedAt": "number (可选)",
      "progress": "string (可选)",
      "result": "string (可选)",
      "error": "string (可选)"
    }
  },
  "messages": [{ "TeamMessage" }],
  "createdAt": "number (timestamp)",
  "updatedAt": "number (timestamp)"
}
```

**Worker 身份** (`worker-identity.json`):
```json
{
  "workerId": "string",
  "role": "RoleId",
  "controllerUrl": "string",
  "registeredAt": "number (timestamp)"
}
```

### 9.2 恢复机制

- **Controller 启动**: `loadTeamState()` 尝试加载已有状态文件。加载时校验 `teamName`、`createdAt`、`updatedAt`、`workers`、`tasks` 字段。如文件不存在或校验失败，创建空白团队状态。
- **Worker 启动**: `IdentityManager.register()` 先检查 `worker-identity.json`，如存在则恢复身份（不再重新生成 `workerId`）。
- **Worker 超时**: Controller 每 15 秒检查一次 Worker 心跳，超过 30 秒未收到心跳的 Worker 标记为 `offline`，并持久化到状态文件。
- **Worker 优雅退出**: `IdentityManager.clear()` 通知 Controller 删除 Worker 记录，然后删除本地身份文件。

---

## 10. Web UI

### 10.1 页面结构

Web UI 位于 `http://localhost:{port}/ui`，为纯静态页面（HTML + CSS + JS）。

```
┌──────────────────────────────────────────────┐
│  TeamClaw            ● connected  Team Name  │  ← Header
├──────────┬───────────────────────────────────┤
│ Workers  │  [Tasks] [Clarifications]         │
│          │  [Messages] [New Task]            │  ← Tabs
│ ──────── │  ─────────────────────────────── │
│ D: idle  │  [All] [Pending] [Assigned] ...   │  ← Filters
│ A: busy  │  ┌────────────────────────────┐   │
│ Q: idle  │  │ MEDIUM  Task title          │   │  ← Task Cards
│          │  │ Task description...         │   │
│ Roles    │  │ pending  Role: developer    │   │
│ ──────── │  └────────────────────────────┘   │
│ 📋 PM    │                                   │
│ 🏗️ Arch  │                                   │
│ 💻 Dev   │                                   │
│ 🔍 QA    │                                   │
│ 🚂 RE    │                                   │
│ ⚙️ Ops   │                                   │
│ 🎨 UX    │                                   │
│ 📣 Mkt   │                                   │
├──────────┴───────────────────────────────────┤
│  > Type a command...                   [Send]│  ← Command Bar
└──────────────────────────────────────────────┘
```

### 10.2 功能区域

| 区域 | 说明 |
|------|------|
| **Header** | 标题、WebSocket 连接状态指示灯（connected/disconnected/connecting）、团队名称 |
| **Sidebar - Workers** | 已注册 Worker 列表，显示标签和状态（idle/busy/offline） |
| **Sidebar - Roles** | 10 个角色的图标和标签列表 |
| **Tasks Tab** | 任务看板，支持按状态过滤（All/Pending/Assigned/In Progress/Blocked/Completed/Failed） |
| **Clarifications Tab** | 待答复/已答复澄清队列；人类可直接提交答案，触发任务恢复 |
| **Messages Tab** | 消息流，显示最近 50 条消息，标注来源角色和消息类型 |
| **New Task Tab** | 手工任务注入入口；原始需求应优先走 Controller 对话，再由 Controller 转成执行任务 |
| **Command Bar** | 命令输入框，支持 `/status`、`/assign <taskId> <role>`，其他输入作为广播消息 |

### 10.3 交互流程

1. 页面加载时调用 `refreshAll()` 拉取 `/api/v1/team/status` 和 `/api/v1/roles`
2. 同时建立 WebSocket 连接 (`/ws`)
3. 收到任意 WebSocket 事件时自动 `refreshAll()`
4. WebSocket 断开时自动重连（间隔 3 秒）
5. 创建任务通过表单提交 `POST /api/v1/tasks`
6. 命令栏通过解析 `/` 前缀实现快捷操作

---

## 11. 部署和验证

### 11.1 启动步骤

#### 启动 Controller

1. 在 `openclaw.json` 中配置插件：

```json
{
  "plugins": {
    "teamclaw": {
      "mode": "controller",
      "port": 9527,
      "teamName": "my-team"
    }
  }
}
```

2. 启动 OpenClaw Gateway：
```bash
openclaw gateway run
```

3. 验证：
```bash
curl http://localhost:9527/api/v1/health
# {"status":"ok","mode":"controller","timestamp":...}

curl http://localhost:9527/api/v1/team/status
# {"teamName":"my-team","workers":[],"tasks":[],...}
```

4. 打开 Web UI：`http://localhost:9527/ui`

#### 启动 Worker

1. 在另一个 OpenClaw 实例的 `openclaw.json` 中配置：

```json
{
  "plugins": {
    "teamclaw": {
      "mode": "worker",
      "port": 9528,
      "role": "developer",
      "teamName": "my-team"
    }
  }
}
```

2. 启动 OpenClaw Gateway：
```bash
openclaw gateway run
```

3. Worker 自动通过 mDNS 发现 Controller 并注册（如 mDNS 不可用，配置 `controllerUrl` 为 `http://localhost:9527`）。

### 11.2 测试场景

在 Docker 集成测试中，可通过环境变量开启 host provisioning 模式：

- `TEAMCLAW_TEST_HOST_PROVISIONING=1`：将 TeamClaw 测试容器切为 `root + privileged`
- `TEAMCLAW_TEST_DOCKER_SOCK=/var/run/docker.sock`：把宿主 Docker socket 传入容器
- `TEAMCLAW_TEST_KUBECONFIG=/path/to/config`：把 kubeconfig 挂入容器
- `TEAMCLAW_TEST_KUBE_CONTEXT=name`：为容器内 CLI 指定首选 context

该模式用于验证虚拟团队能否在受控前提下自行 provision benchmark 所需的共享依赖（如 Git 服务、issue tracker、mock 部署环境）。TeamClaw 本身不假定这些能力永远存在；如果宿主没有显式提供对应挂载/凭据，角色应通过 clarification 阻塞并等待人类补充。

#### 场景 1：Worker 注册

```bash
# 验证 Worker 已注册
curl http://localhost:9527/api/v1/workers
# 应返回包含新 Worker 的数组
```

#### 场景 2：任务创建和自动分配

```bash
# 创建任务（指定 developer 角色）
curl -X POST http://localhost:9527/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"实现登录功能","description":"实现用户登录页面","priority":"high","assignedRole":"developer","createdBy":"boss"}'

# 验证任务已自动分配
curl http://localhost:9527/api/v1/tasks
# 应返回 assigned 状态的任务
```

#### 场景 3：消息路由

```bash
# 发送直接消息
curl -X POST http://localhost:9527/api/v1/messages/direct \
  -H "Content-Type: application/json" \
  -d '{"from":"boss","fromRole":"pm","toRole":"developer","content":"请优先处理登录功能"}'

# 验证 Worker 收到消息
curl http://localhost:9528/api/v1/messages
```

#### 场景 4：任务完成

```bash
# Worker 提交结果
curl -X POST http://localhost:9527/api/v1/tasks/{taskId}/result \
  -H "Content-Type: application/json" \
  -d '{"result":"登录功能已实现"}'

# 验证任务状态
curl http://localhost:9527/api/v1/tasks/{taskId}
# 应返回 completed 状态
```

#### 场景 5：Worker 超时

```bash
# 停止 Worker 进程
# 等待 30 秒后检查 Worker 状态
curl http://localhost:9527/api/v1/workers
# Worker 状态应变为 offline
```

#### 场景 6：WebSocket 实时推送

```bash
# 使用 wscat 连接 WebSocket
wscat -c ws://localhost:9527/ws

# 在另一个终端创建任务
curl -X POST http://localhost:9527/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"测试任务","description":"WebSocket 推送测试"}'

# wscat 应收到 task:created 事件
```

#### 场景 7：任务转交

```bash
# Worker 建议转交
curl -X POST http://localhost:9527/api/v1/tasks/{taskId}/handoff \
  -H "Content-Type: application/json" \
  -d '{"targetRole":"qa","fromWorkerId":"{workerId}","reason":"需要测试验证"}'
```
