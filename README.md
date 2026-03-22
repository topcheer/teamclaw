# TeamClaw

OpenClaw 虚拟团队协作插件 — 多个 OpenClaw 实例组成虚拟软件公司，基于角色进行任务路由。

## 架构

TeamClaw 是 OpenClaw 的扩展插件，通过 git submodule 引入 openclaw 核心，插件源码独立于 `src/` 目录管理。

```
TeamClaw/
├── openclaw/          # git submodule -> openclaw 仓库
├── src/               # teamclaw 插件源码
├── tests/             # Docker 集成测试
├── scripts/           # 开发工具脚本
└── screenshots/       # 截图
```

## 快速开始

### 1. 克隆并初始化子模块

```bash
git clone <repo-url>
cd TeamClaw
git submodule update --init --recursive
```

### 2. 创建开发符号链接

```bash
bash scripts/symlink-extension.sh
```

这将创建 `openclaw/extensions/teamclaw -> ../../src` 的符号链接，使 openclaw 的 pnpm workspace 能发现 teamclaw 包。

### 3. 安装依赖

```bash
cd openclaw
pnpm install
```

### 4. 运行

```bash
pnpm openclaw gateway run
```

## 模式

### Controller 模式

管理团队：维护团队状态、分发任务、收集结果。

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team"
}
```

### Worker 模式

执行任务：自动发现 Controller、注册角色、接收并执行任务。

```json
{
  "mode": "worker",
  "port": 9528,
  "role": "developer"
}
```

## 支持的角色

| 角色 | 描述 |
|------|------|
| pm | 产品经理 |
| architect | 架构师 |
| developer | 开发者 |
| qa | 测试工程师 |
| release-engineer | 发布工程师 |
| infra-engineer | 基础设施工程师 |
| devops | DevOps |
| security-engineer | 安全工程师 |
| designer | 设计师 |
| marketing | 市场营销 |

## 测试

### Docker 集成测试

```bash
bash tests/run-tests.sh           # 完整构建 + 测试
bash tests/run-tests.sh --skip-build  # 复用已有镜像
bash tests/run-tests.sh --keep        # 保留容器
```

## 项目结构

```
src/
├── index.ts              # 插件入口
├── api.ts                # openclaw/plugin-sdk 导出
├── package.json          # 包配置
├── tsconfig.json         # TypeScript 路径配置
├── openclaw.plugin.json  # 插件元数据
└── src/
    ├── types.ts          # 类型定义
    ├── config.ts         # 配置 schema
    ├── roles.ts          # 角色定义
    ├── state.ts          # 团队状态管理
    ├── protocol.ts       # 通信协议
    ├── discovery.ts      # mDNS 服务发现
    ├── identity.ts       # Worker 身份管理
    ├── controller/       # Controller 模式实现
    ├── worker/           # Worker 模式实现
    └── ui/               # Dashboard 前端
```
