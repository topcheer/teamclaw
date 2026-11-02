# TeamAuto 设计（v1 定稿）

让 TeamClaw 像一支真实团队一样**自主工作**在用户绑定的 GitHub 仓库中：定时扫描
issues / PRs / commits，主动认领与实现工作，产出带 teamclaw 标识的
issue / PR / 评论 / commit，并遵守目标仓库自身的协作规范。

## 已拍板的产品决策（2026-11-01 与用户确认）

| 决策点 | 结论 |
| --- | --- |
| 自主级别 | **完全自主**：评论 / PR / issue 直接发布，事后查看结果 |
| issue 认领范围 | **所有未分配且无人认领**的 issue（跳过 assignee 非空者）；绑定仓库时可配置**过滤关键字**（include/exclude） |
| 代码推送方式 | **直接推 `teamclaw/*` 分支到源仓库**（需 GitHub App 开 Contents: Read & Write） |
| 身份呈现 | 以**当前登录用户账号**活动 + 统一 teamclaw/role 标识后缀 |
| 扫描节奏 | 默认**每 30 分钟**，每仓库每轮任务上限 5（每 repo 可覆盖） |
| 模糊协作处理 | 走现有 **clarification 阻塞**流程，等用户回答后继续 |

## 前置条件（GitHub App 侧）

1. GitHub App 安装到目标仓库/账号（user token 只能看到已安装仓库的私有内容）
2. 权限：Contents: RW、Issues: RW、Pull requests: RW、Metadata: R
3. 设备流登录已完成（token 自动刷新由 `github-auth.ts` 处理，调用方透明）

## 架构

```
┌─ 调度器（每 repo 独立 cron，默认 */30 * * * *）──────────┐
│  teamauto.json: repos[{id, schedule, policy, cursors}]   │
└───────────────┬──────────────────────────────────┘
                ▼ 每轮 sweep（增量）
  GitHub API：issues?since= / pulls?sort=updated / commits(after=lastSha)
  （ETag 条件请求，304 则本轮零成本跳过）
                ▼
  过滤（认领规则/关键字/黑名单标签）→ 去重（幂等键 repo#type-id）
                ▼
  生成 TeamClaw 任务（注入该 repo 的协作规范 norms）
                ▼
  现有 TaskRouter → role worker 执行 → GitHub 写回（统一标识）
```

- 任务生命周期、clarification 阻塞、角色路由全部**复用现有控制器机制**
- clone 位置：`<workspace>/projects/teamauto/<owner>__<repo>`（任务携带 projectDir 指向该目录；存量旧位置 clone 首次访问时自动迁移）
- token **不落盘**：git 操作用 `-c http.https://github.com/.extraheader=Authorization:...` 动态注入；API 用 `getAuthHeaders()`

## 数据模型（`~/.openclaw/plugins/teamclaw/teamauto.json`）

```jsonc
{
  "repos": [{
    "id": "owner/repo",
    "enabled": true,
    "schedule": "*/30 * * * *",
    "policy": {
      "maxTasksPerSweep": 5,
      "actions": { "issueReview": true, "takeOwnership": true,
                   "prReview": true, "createPR": true,
                   "fullReview": "weekly" },
      "skipAssignedToHumans": true,
      "labelFilter": { "include": [], "exclude": ["wontfix", "teamclaw-skip"] },
      "keywordFilter": { "include": [], "exclude": [] }   // 绑定时可配
    },
    "cursors": { "lastIssueNumber": 0, "lastIssueSince": 0,
                 "lastPrNumber": 0, "lastCommitSha": "",
                 "lastFullReviewAt": 0, "etag": {} },
    "norms": { "commitStyle": "conventional|other",
               "issueTemplate": "...", "prTemplate": "...",
               "learnedAt": 0 }
  }],
  "budget": { "maxTasksPerDay": 50, "firstSweepDryRun": true }
}
```

## 任务类型 → 角色 → 输出标识

| 触发 | 任务 | 角色 | 写回（统一标识） |
| --- | --- | --- | --- |
| 新 issue | 分诊 + review | pm → qa | 评论 `[teamclaw:pm]` / `[teamclaw:qa]` |
| 未认领 issue | take ownership | developer | 分支 `teamclaw/issue-<n>-<slug>` → commit（`Co-Authored-By: teamclaw <noreply@teamclaw.dev>` trailer + 仓库规范风格）→ PR `[teamclaw] ...` |
| 新 PR | code review | qa | PR review 评论 `[teamclaw:qa]` |
| 周期 | 全量 review | architect + qa | 大发现开 issue `[teamclaw:architect]` |

所有写回内容尾部：`---\n🤖 TeamClaw (<role>) · autonomous`。

## 协作规范转手（绑定时自动学习，可手动刷新）

读取 `CONTRIBUTING.md`、`.github/ISSUE_TEMPLATE/*`、`PULL_REQUEST_TEMPLATE.md`、
`CODEOWNERS`、最近 200 条 commit message 分析提交风格 → 存 `norms` →
经 prompt-injector 注入该 repo 的所有 worker 提示词。

## 护栏

- 永不直接提交 `main`；只从 `teamclaw/*` 分支发 PR
- 跳过已分配给真人的 issue；`WIP` / `do-not-automate` 标签黑名单
- 幂等：同一对象（issue/PR/commit）上轮任务未完成不重派；轮内上限 5、日上限 50
- 新绑定仓库首轮默认 dry-run（只生成行动报告不落 GitHub），可关闭
- GitHub API 限流：ETag + 指数退避；克隆失败/鉴权失败自动暂停该 repo 并在 UI 告警

## 分期

- **P1**：绑定/clone/调度/增量扫描 + issue&PR review（只评论）+ 管理面板
  （Web UI 与桌面端：绑定 repo 列表、节奏、开关、运行日志）
- **P2**：take ownership 全链路（分支 → 实现 → PR）
- **P3**：全量 review 与 issue 创建、规范学习完善、预算统计面板

## 开放项（实现期再确认，不阻塞 P1）

- 全量 review 的"全量"粒度（按目录分片 vs 单次全仓）
- 同一 repo 多任务并发写回的串行化锁粒度

## 实现后演进（2026-11-02，均已上线）

- **联合全量评审**：fullReview 从单角色 architect 扇出为三角色联合（architect/qa/security-engineer 各出一节，共享周期 id），写回合并为一条伞形 issue（首段创建、其余分节评论）；fullReview 候选绕过每轮 cap（防活跃仓库饿死）。
- **读写协作契约**：`TaskInfo.writeMode` 分类——review 类只读（禁写令 + 锚定 HEAD，忽略并发写者的脏工作区），ownership 为写；同一仓库至多一个活动写任务（派发层串行）；写任务在专属 git worktree（`teamclaw/task-<id>` 分支，断点续跑同树复用）执行，完成后 commit→push→开 PR→issue 评论附 "Delivered as PR"→清理 worktree。
- **断点续跑**：执行期 assistant 心跳落盘（15s 节流）→ 网关重启后孤儿任务带 checkpoint 续跑（复用原会话键 + 注入 RESUMED 上下文），3 次上限后 fail-fast。
- **activity 持久化**：bind/provision/sweep/task/writeback/PR 六类事件入 `teamauto.json`（100 条上限），`GET /api/v1/teamauto/activity` + 双端 UI 动态流；load 白名单已含 activity（曾因白名单重建丢字段，PR #56 修复）。
- **去重与死信**：幂等键升级为 对象+类型（对象级键曾饿死 takeOwnership）；写回条目对"任务缺失/失败无结果"死信自动清账；早提交被拒后完成的条目自愈重试。
