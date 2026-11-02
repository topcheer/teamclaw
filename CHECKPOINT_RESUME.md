# TeamClaw 任务断点续跑（Checkpoint & Resume）设计

服务更新（网关重启）时，运行中的任务不再从头重跑，而是带着中断前的进度续跑。

## 核心思路

LLM 执行无法（也不需要）序列化"中间张量"——**会话与文件系统已经是持久化状态**：

- OpenClaw 会话（`executionSessionKey`）落盘，含完整对话历史
- 已写的文件/提交天然留在磁盘

因此断点续跑 = **进度心跳 + 会话复用 + 续跑注入 + 重试上限**，不重造执行引擎。

## 数据模型（`TaskInfo.checkpoint`）

```jsonc
{
  "updatedAt": 1793...,        // 最近一次心跳
  "attempt": 2,                // 第几次续跑（控制器递增）
  "sessionKey": "agent:teamclaw:teamclaw-task-...",  // 中断前的会话键
  "lastAssistantMessage": "...", // 中断前最后的 assistant 输出（截断 8KB）
  "progressNotes": ["..."]     // 已验证完成事项（上限 10 条）
}
```

## 流水线

```
执行中（worker）
  └─ task-executor 轮询会话进度：每条 assistant 消息（节流 15s/次）
     POST /api/v1/tasks/:id/checkpoint → controller 存入 task.checkpoint
  └─ 心跳尽力而为：丢失只损失续跑新鲜度，不影响执行

服务重启（controller-service.start 启动对账）
  └─ 孤儿任务（assigned/in_progress 且 worker 消失）
     ├─ resumeAttempt ≤ 3：重置 pending，保留 checkpoint，attempt+1
     └─ resumeAttempt > 3：置 failed（错误信息含最后 checkpoint 摘要）——防死循环

重新派发（dispatchTaskToWorker）
  ├─ assignment.checkpoint = task.checkpoint（带进度）
  ├─ 有 checkpoint 时 executionSessionKey 复用中断前的会话键
  │  → worker 在同一持久会话中继续，LLM 看得到自己的历史
  └─ worker-service 构造 prompt 时附加 "## RESUMED EXECUTION"：
     声明这是续跑、禁止重做已完成步骤、展示最后动态与进度笔记
```

## 各状态任务在重启后的行为

| 中断时状态 | 行为 |
| --- | --- |
| pending | 正常派发（无续跑语义） |
| assigned / in_progress | **续跑**：同会话 + 注入进度，attempt+1 |
| in_progress 且已续跑 3 次 | failed（带诊断），人工介入 |
| blocked（等 clarification） | 保持 blocked，回答后自然继续（原有机制） |
| completed / failed | 不变 |

## 边界与取舍

- **心跳粒度**：15s 节流 + 8KB 截断 + 10 条笔记上限——控制写放大；最坏丢失 15s 进度
- **文件半成品**：续跑 worker 被明确要求"先核验磁盘/git 状态再行动"，不重做
- **GitHub 写回**：单任务单写回的既有幂等不受影响；续跑完成后仍只发一条评论
- **kickoff 评估等一次性会话**：无 checkpoint（无 assistant 心跳匹配条件），保持原重跑语义
