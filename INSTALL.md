# TeamClaw 安装指南

这份文档面向**第一次安装/试用 TeamClaw 的用户**，目标不是解释全部架构细节，而是让你尽快把系统跑起来，并且后续容易扩展。

如果你只是想知道源码结构、测试方式或实现细节，请看 `README.md` 和 `DESIGN.md`。

## 一键安装（推荐给已经能跑通 OpenClaw 的用户）

如果你的本地 OpenClaw 已经有可用模型配置，最省事的方式是直接运行：

```bash
npx -y @teamclaws/teamclaw install
```

installer 会优先把自己当前运行的 TeamClaw 打成**本地 tar 包**再交给 OpenClaw 安装，这样可以绕开 ClawHub 限流和“尚未上架插件”的问题；如果本地打包失败，才会回退到精确版本安装（例如 `@teamclaws/teamclaw@2026.3.24-8`），避免 `YYYY.M.D-N` 这种 date+build-number 版本格式被 OpenClaw 当成“未显式选择的 prerelease”而拒绝。

这个 guided installer 会帮你：

- 安装/更新 TeamClaw 插件
- 自动定位本地 `openclaw.json`
- 让你选择安装模式（单机 localRoles / controller / worker / on-demand）
- 从你现有的 OpenClaw 模型配置里列出模型供你选择
- 让你显式选择 OpenClaw workspace 目录（默认改为 TeamClaw 独立 workspace，而不是直接复用现有 OpenClaw workspace）
- 为 Docker / Kubernetes 预填默认运行镜像：
  - `ghcr.io/topcheer/teamclaw-openclaw:latest`
- 在 Docker / Kubernetes 模式下默认使用隔离的临时 workspace；如果你需要持久化/复用，再显式填写 volume 或 PVC

它只会读取模型列表和当前默认模型，不会把你现有的 API key 打印到终端。

## 先选安装路径

**推荐顺序：**

1. **先从“单机 + localRoles”开始**（最推荐）
2. 跑通后，再考虑：
   - 多机分布式 Worker
   - 按需启动 Worker（process / docker / kubernetes）

原因很简单：

- `localRoles` 不需要先解决多机网络、mDNS、镜像分发、控制面地址可达性等问题
- Web UI、Clarifications、Workspace、Git 协作都能先在一台机器上验证
- 真正遇到问题时，排查面最小

## 安装前准备

### 必备条件

- `git`
- `Node.js` / `pnpm`
- 一份**已经能在 OpenClaw 跑通**的模型配置

### 建议的首次体验环境

- macOS / Linux
- 单台机器
- 角色只开：`architect`、`developer`、`qa`

### 端口约定

- OpenClaw Gateway：`18789`
- TeamClaw Controller API / Web UI：`9527`

如端口冲突，可以改，但第一次安装建议先保持默认值，排查最省心。

## 推荐安装路径：单机 + localRoles

这是**最适合首次安装**的方案。

### 1. 拉代码

```bash
git clone <repo-url>
cd TeamClaw
git submodule update --init --recursive
```

### 2. 让 OpenClaw 能发现 TeamClaw 扩展

```bash
bash scripts/symlink-extension.sh
```

这会创建：

```text
openclaw/extensions/teamclaw -> ../../src
```

这样你不需要手工复制扩展源码。

### 3. 安装依赖

```bash
cd openclaw
pnpm install
cd ..
```

### 4. 准备一个**隔离的本地运行目录**

为了不污染你已有的 `~/.openclaw`，第一次安装建议直接在仓库里放一个单独目录：

```bash
mkdir -p .teamclaw-home
```

然后把下面这份示例配置保存到：

```text
.teamclaw-home/openclaw.json
```

### 5. 写配置文件

> 下面示例的重点是 TeamClaw 插件块和超时时间。  
> `models.providers` / `agents.defaults.model` 请替换成**你已经验证过可用于 OpenClaw**的模型配置。

```json
{
  "models": {
    "providers": {
      "my-provider": {
        "baseUrl": "https://YOUR-OPENAI-COMPATIBLE-ENDPOINT/v1",
        "apiKey": "YOUR_API_KEY",
        "api": "openai-completions",
        "models": [
          {
            "id": "YOUR_MODEL_ID",
            "name": "YOUR_MODEL_NAME",
            "reasoning": false,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            },
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "my-provider/YOUR_MODEL_ID",
      "timeoutSeconds": 2400,
      "workspace": "/absolute/path/to/teamclaw/workspace"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan"
  },
  "plugins": {
    "enabled": true,
    "entries": {
      "teamclaw": {
        "enabled": true,
        "config": {
          "mode": "controller",
          "port": 9527,
          "teamName": "my-team",
          "taskTimeoutMs": 1800000,
          "gitEnabled": true,
          "gitDefaultBranch": "main",
          "gitAuthorName": "TeamClaw",
          "gitAuthorEmail": "teamclaw@local",
          "localRoles": ["architect", "developer", "qa"]
        }
      }
    }
  }
}
```

### 6. 启动

```bash
cd openclaw
OPENCLAW_HOME=../.teamclaw-home pnpm openclaw gateway run
```

### 7. 验证是否启动成功

先看健康检查：

```bash
curl http://127.0.0.1:9527/api/v1/health
```

看到类似结果即可：

```json
{"status":"ok","mode":"controller", ...}
```

然后打开 Web UI：

```text
http://127.0.0.1:9527/ui
```

如果一切正常，你会看到：

- Workers 列表里有 `architect` / `developer` / `qa`
- Tasks / Clarifications / Workspace / Messages 标签页可用

### 8. 第一次建议怎么试

不要一上来就测超复杂分布式链路。先用一句简单需求确认流程跑通，例如：

```text
在 workspace 中创建一个最小的静态站点，包含 README、index.html 和 style.css。
```

确认以下链路都正常：

- Controller 能分析需求并创建任务
- local worker 能自动接单
- workspace 中能看到文件产出
- Web UI 能看到任务详情和消息

只要这条链跑通，再升级到更复杂的项目。

## 为什么推荐把超时时间调大

首次安装时最常见的误判之一，是以为 TeamClaw 坏了，其实只是 **OpenClaw 内层 agent 先超时了**。

你需要同时关注两层超时：

- TeamClaw：`taskTimeoutMs`
- OpenClaw：`agents.defaults.timeoutSeconds`

经验上，第一次安装建议至少：

- `taskTimeoutMs = 1800000`（30 分钟）
- `agents.defaults.timeoutSeconds = 2400`（40 分钟）

简单说就是：**OpenClaw 的 timeout 不要小于 TeamClaw 的 timeout**。

另外，本地 `localRoles` / `process` worker 的运行目录现在会跟随 `agents.defaults.workspace` 的父目录，在旁边创建 `teamclaw-runtimes/`，而不是硬编码落到 `/tmp`。所以如果你希望 workspace 与临时 runtime 都落到持久化磁盘，请优先把 `agents.defaults.workspace` 配到目标路径。

## 升级路径 1：多机分布式 Worker

只有在你已经确认单机模式稳定后，才建议切到分布式。

### Controller 端核心配置

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team",
  "taskTimeoutMs": 1800000,
  "gitEnabled": true,
  "gitDefaultBranch": "main"
}
```

### Worker 端核心配置

```json
{
  "mode": "worker",
  "port": 9528,
  "role": "developer",
  "taskTimeoutMs": 1800000,
  "gitEnabled": true,
  "gitDefaultBranch": "main",
  "controllerUrl": "http://YOUR_CONTROLLER_HOST:9527"
}
```

### 分布式首次安装的建议

- 先只起一个 `developer` worker
- `controllerUrl` 先写死，不要第一次就依赖 mDNS 自动发现
- 先确认 worker 能注册，再慢慢加更多角色

## 升级路径 2：按需启动 Worker

按需拉起 worker 很强，但**不适合第一次安装就上**。

支持三种 provider：

- `process`：同机裸环境 / 单机进程
- `docker`：controller 通过 Docker API 起容器
- `kubernetes`：controller 通过 `kubectl` 起 Pod

### 最推荐的第一步：先试 `process`

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team",
  "workerProvisioningType": "process",
  "workerProvisioningRoles": [],
  "workerProvisioningMinPerRole": 0,
  "workerProvisioningMaxPerRole": 2,
  "workerProvisioningIdleTtlMs": 120000,
  "workerProvisioningStartupTimeoutMs": 120000
}
```

`workerProvisioningRoles` 留空或设为 `[]`，表示 controller 可以在运行时按需决定默认启用哪些角色；即使你填写了一个偏好的角色子集，只要出现了明确需要其它角色的 pending task，controller 仍然会按需拉起那个角色。

如果 `process` 都没跑顺，再上 `docker` / `kubernetes` 只会更难排查。

### Docker / Kubernetes 安装前必须先想清楚

1. 新 worker **怎么回连 controller**
2. worker **怎么拿到镜像 / 运行时依赖**
3. worker **怎么获得 Docker / kubectl / 凭据**
4. Pod / 容器里看到的 `controllerUrl` 是否真的可达

所以这两种模式更像“二阶段部署能力”，而不是首次安装入口。

## Kubernetes / Helm 补充说明

如果你准备把 TeamClaw controller 正式放到 Kubernetes 中运行，现在可以直接使用仓库里的 Helm chart：

- `deploy/helm/teamclaw`

这个 chart 会负责：

- controller Deployment
- Service
- `openclaw.json` Secret
- ServiceAccount / RBAC
- workspace PVC
- 可选 Ingress

Ingress 默认做法是：

- `ingress.className` 留空，使用集群默认 ingress class
- TLS 相关能力通过 `ingress.annotations` 透传，例如 cert-manager 的 issuer 注解

测试域名示例（`teamclaw.iot2.win`）：

```bash
cat > teamclaw-ingress.values.yaml <<'EOF'
ingress:
  enabled: true
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-production
  hosts:
    - host: teamclaw.iot2.win
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: teamclaw-iot2-win-tls
      hosts:
        - teamclaw.iot2.win
EOF

helm upgrade --install teamclaw ./deploy/helm/teamclaw \
  --namespace teamclaw --create-namespace \
  -f teamclaw-ingress.values.yaml
```

如果你的 TeamClaw controller 还需要在集群内按需创建 worker Pod，请记得：

1. controller 运行环境里要有 `kubectl`（TeamClaw runtime image 已内置；如果你换自定义镜像，需要自己带上）
2. ServiceAccount 需要有创建/删除 Pod 的权限
3. `workerProvisioningControllerUrl` 要指向 controller 的 cluster service DNS

当前 chart 默认会同时创建：

- controller `ServiceAccount` + `Role/RoleBinding`
- worker `ServiceAccount`

其中 controller 的 `Role` 已包含 TeamClaw Kubernetes provisioner 需要的 namespace 内 `pods` 权限；worker `ServiceAccount` 默认不授予额外 RBAC。

## 常见问题

### 1. Web UI 里显示没有 worker

优先检查：

- `localRoles` 是否配置了
- `mode` 是否是 `controller`
- `http://127.0.0.1:9527/api/v1/workers` 是否有返回

### 2. 任务总是在 10 分钟左右被打断

通常不是 TeamClaw 本身的问题，而是：

- `agents.defaults.timeoutSeconds` 太小

先把它调大，再重试。

### 3. architect 完成后，developer 没继续

新版本源码已经支持 **controller-created task 完成后自动续跑同一条 intake 会话**。  
如果你看到旧行为，通常说明你还在跑旧容器 / 旧进程，需要重启到新的 TeamClaw 代码。

### 4. Docker / Kubernetes worker 起了但一直注册不上

先不要猜，先确认两件事：

- `workerProvisioningControllerUrl` 对 worker 是否真的可达
- 运行环境里的模型 / 代理 / kube / docker 依赖是否真的存在

很多“注册慢”或“注册不上”其实是 worker 进程启动后卡在上游依赖初始化。

## 安装建议总结

如果你想把安装体验做得最顺：

1. **先单机 `localRoles`**
2. **先用简单需求冒烟**
3. **先把 timeout 调对**
4. **确认 Web UI / Workspace / Clarifications 都正常**
5. **最后再上分布式或按需 provisioning**

这是目前最省时间、最少坑、最容易判断问题归因的路径。
