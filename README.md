# TeamClaw

OpenClaw 虚拟团队协作插件 — 多个 OpenClaw 实例组成虚拟软件公司，基于角色进行任务路由。

## 安装入口

如果你是**第一次安装 / 试用** TeamClaw，请先看 [`INSTALL.md`](./INSTALL.md)。

- 想最快跑起来：看 `INSTALL.md` 的“单机 + localRoles”
- 想后续扩展到多机 / 按需 worker：也建议先按 `INSTALL.md` 的推荐路径完成第一次单机安装
- 本 README 下面的“快速开始”更偏向**源码开发者**工作流

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

## 开发者快速开始

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

在与人类直接交互时，Controller 也是**第一责任需求分析师**：默认把人类输入视为原始需求，先提炼目标、范围、约束与缺失决策，必要时先向人类澄清，再把需求翻译为可执行的 TeamClaw 任务包。

这里的“可执行任务包”指**当前就能开始的 live work**，而不是把整个 roadmap 一次性物化成未来 backlog。若某些后续阶段依赖尚未产出的前置结果，Controller 应先把它们保留为分析结论/计划说明，等前置任务完成后再创建新的 TeamClaw 任务。

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

### Controller + Local Roles 模式

在一个 OpenClaw 实例中同时运行 Controller 和多个本地虚拟 Worker，不再强依赖多实例部署。

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team",
  "taskTimeoutMs": 1800000,
  "gitEnabled": true,
  "gitDefaultBranch": "main",
  "localRoles": ["architect", "developer", "qa"]
}
```

`localRoles` 会将这些角色注册为**controller 托管的本地子 Worker**：Controller 会在同一台机器上额外拉起独立的 OpenClaw child process，每个角色都有自己隔离的 `OPENCLAW_STATE_DIR`、gateway / worker 端口和注册身份，但继续共享同一个 `workspace/`。这样任务与消息仍然通过 TeamClaw 的路由机制流转，同时把真实模型执行从 Controller 主进程里隔离出去，避免活跃本地任务把 Web/API 一起拖慢。`taskTimeoutMs` 用于控制单个角色任务最多可执行多久；对真实模型长链路协作，建议显式调大。对于原始需求输入，推荐先经过 Controller 的需求分析/澄清，再把**当前可启动**的结果下发给各角色，而不是预先创建还不能开始的后续任务。

本地 child worker / process worker 的运行根目录现在不再固定写到 `/tmp`。默认会跟随 `agents.defaults.workspace` 的父目录，在旁边创建 `teamclaw-runtimes/`；如果你想把本地 workspace / runtime 都放到自定义磁盘位置，只需要把 OpenClaw 的 `agents.defaults.workspace` 指到目标目录即可。

注意：如果底层 OpenClaw 仍保留默认的 `agents.defaults.timeoutSeconds = 600`，那么长任务会先被 OpenClaw 内层 agent timeout 打断，实际生效上限会比 TeamClaw 的 `taskTimeoutMs` 更短。跑真实长链路时，建议同时把 OpenClaw 的 `agents.defaults.timeoutSeconds` 调到不小于 `taskTimeoutMs / 1000`，或者显式设成更大的值。

当某个角色因为缺少关键需求、产品决策或技术前提而无法继续时，应通过 `teamclaw_request_clarification` 向 Controller 发起明确问题。对应任务会进入 `blocked` 状态，并出现在 Web UI 的 `Clarifications` 标签页中；人类答复后，任务会自动回到待执行/已分配状态继续流转，而不是让角色自行猜测或旁路。

同样地，如果 Infra / DevOps 角色发现当前环境没有暴露所需的基础设施、凭据或外部工具能力，或者只有商业/专有方案才能继续，也必须阻塞并请求澄清；默认优先选择开源/免费方案，不允许“假装已经有一套基础设施”继续推进。

### Controller + On-demand Worker Provisioning

如果希望 controller 按需拉起 worker，而不是预先常驻所有角色，现在可以在 controller 侧开启 `workerProvisioningType`：

- `process`：同机裸环境 / 单机进程模式。controller 在同一台机器上按需启动新的 OpenClaw worker 进程。
- `docker`：controller 通过 Docker API 拉起临时 worker 容器。
- `kubernetes`：controller 通过 `kubectl` 创建临时 worker Pod。

这些 provisioned worker 会带着预生成的 `workerId + launchToken` 注册回 controller；controller 只接受匹配 token 的受管 worker，避免有人伪造同名 worker 混入。

当 worker 明确拿到了 `controllerUrl` 时，会优先直接使用这个地址，不再先走 mDNS 探测；这对 `docker` / `kubernetes` 这类跨网络拓扑尤其重要，也能避免因为运行时 hostname 太长或 mDNS 不可用而导致启动阶段异常。

最小示例（单机 / bare-process）：

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team",
  "workerProvisioningType": "process",
  "workerProvisioningRoles": ["developer", "qa"],
  "workerProvisioningMinPerRole": 0,
  "workerProvisioningMaxPerRole": 2,
  "workerProvisioningIdleTtlMs": 120000,
  "workerProvisioningStartupTimeoutMs": 120000
}
```

Docker 示例：

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team",
  "workerProvisioningType": "docker",
  "workerProvisioningControllerUrl": "http://host.docker.internal:9527",
  "workerProvisioningImage": "ghcr.io/topcheer/teamclaw-openclaw:latest",
  "workerProvisioningWorkspaceRoot": "/workspace-root",
  "workerProvisioningDockerWorkspaceVolume": "teamclaw-workspaces",
  "workerProvisioningRoles": ["developer", "qa", "infra-engineer"],
  "workerProvisioningMaxPerRole": 3,
  "workerProvisioningDockerMounts": [
    "/var/run/docker.sock:/var/run/docker.sock"
  ],
  "workerProvisioningPassEnv": ["DOCKER_HOST", "DOCKER_CONFIG", "KUBECONFIG", "NO_PROXY"]
}
```

Kubernetes 示例：

```json
{
  "mode": "controller",
  "port": 9527,
  "teamName": "my-team",
  "workerProvisioningType": "kubernetes",
  "workerProvisioningControllerUrl": "http://teamclaw-controller.default.svc.cluster.local:9527",
  "workerProvisioningImage": "ghcr.io/topcheer/teamclaw-openclaw:latest",
  "workerProvisioningWorkspaceRoot": "/workspace-root",
  "workerProvisioningKubernetesWorkspacePersistentVolumeClaim": "teamclaw-workspace",
  "workerProvisioningRoles": ["developer", "qa"],
  "workerProvisioningKubernetesNamespace": "default",
  "workerProvisioningKubernetesServiceAccount": "teamclaw-worker",
  "workerProvisioningPassEnv": ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]
}
```

注意事项：

1. `workerProvisioningControllerUrl` 对 `docker` / `kubernetes` 是必填，因为新 worker 需要一个明确可达的 controller 地址。
2. `kubernetes` 下这个 URL 必须是 **Pod 真正可达** 的地址。最稳妥的方式是把 controller 自己也放进集群里，并使用 cluster service DNS（例如 `http://teamclaw-controller.default.svc.cluster.local:9527`）；如果 controller 在集群外，就需要额外提供一个从 Pod 网络可达的 ingress / tunnel / 网关地址。
3. `workerProvisioningPassEnv` / `workerProvisioningExtraEnv` 是**显式转发**机制；默认不会把 controller 的全部环境变量都传给 worker。
4. `workerProvisioningDockerMounts` 只对 Docker provider 生效；Kubernetes 下请用 service account、secret、configmap 或镜像内置工具来提供运行时依赖。
5. `kubernetes` provider 当前依赖 `kubectl` 在 controller 运行环境中可用；TeamClaw runtime image 现在已内置 `kubectl`。如果你换成自定义 controller 镜像，仍需要自行保证 `kubectl` 存在。`docker` provider 直接走 Docker API，不依赖容器内安装 `docker` CLI。
6. 如果你为 Docker 设置了 `workerProvisioningDockerWorkspaceVolume`，TeamClaw 会把这个 named volume / host path 挂到 `workerProvisioningWorkspaceRoot`，并在其中按 `team/role/workerId` 为每个 worker 分配独立 workspace，从而在 worker 重建后保留 repo / skills / memory。
7. 如果你为 Kubernetes 设置了 `workerProvisioningKubernetesWorkspacePersistentVolumeClaim`，TeamClaw 会把 PVC 挂到 `workerProvisioningWorkspaceRoot`，并用同样的 `team/role/workerId` 目录层级隔离每个 worker 的持久化 workspace。
8. `ghcr.io/topcheer/teamclaw-openclaw:latest` 现在额外预装了 `clawhub` CLI，因此容器里的 OpenClaw 会直接具备 ClawHub skill 发现 / 安装能力，不需要再在 worker 容器里手工 `npm i -g clawhub`。

对 Kubernetes 来说，**Helm 很适合管理 controller 这一侧的静态资源**：`Deployment`、`Service`、`ConfigMap/Secret`、`ServiceAccount/RBAC`、以及上面的 workspace PVC；但 Helm 不应该去管理 TeamClaw 按需创建的那些临时 worker Pod，后者仍然应该由 TeamClaw controller 根据任务负载动态拉起和回收。

### Helm 部署（含 Ingress）

仓库现在提供了一个基础 Helm chart：

- `deploy/helm/teamclaw`

它会管理：

- controller `Deployment`
- `Service`
- `Secret(openclaw.json)`
- controller `ServiceAccount + Role + RoleBinding`
- worker `ServiceAccount`
- workspace `PVC`
- 可选 `Ingress`

Ingress 的设计要点：

- `ingress.className` 默认留空，这样会使用集群里的**默认 ingressClass**
- `ingress.annotations` 用于传入额外注解，适合接 cert-manager / 测试环境 TLS
- `ingress.tls` 用于声明 host + secretName

测试环境示例（域名 `teamclaw.iot2.win`）：

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

如果你的集群已经配置了默认 ingress class，上面不需要再显式设置 `ingress.className`。

默认情况下：

- controller Pod 使用 chart 创建的 `ServiceAccount`，并通过 `Role/RoleBinding` 获得 namespace 内 `pods` 的创建/删除等权限，供 TeamClaw 的 Kubernetes provisioner 使用
- worker Pod 使用单独的 worker `ServiceAccount`
- worker `ServiceAccount` 默认**不绑定额外 RBAC**，保持最小权限；如果你的 worker 任务本身需要访问 Kubernetes API，再按需额外绑定权限

### Worker 模式

执行任务：自动发现 Controller、注册角色、接收并执行任务。

```json
{
  "mode": "worker",
  "port": 9528,
  "role": "developer",
  "taskTimeoutMs": 1800000,
  "gitEnabled": true,
  "gitDefaultBranch": "main"
}
```

### Git-based workspace collaboration

TeamClaw 现在把 **git** 作为默认的文件协同机制：

- **单实例 / localRoles**：Controller 会在共享 `workspace/` 中初始化一份 git 仓库；所有本地 Worker 继续共享同一个工作区，只是现在这个工作区自带版本历史。
- **分布式部署**：Controller 仍然先初始化同一份工作区仓库。默认情况下，远端 Worker 会通过 Controller 提供的 **git bundle** 接口同步 checkout，所以即使没有外部 Git 服务也能工作。
- **显式 remote**：如果配置了 `gitRemoteUrl` 且 Controller 能成功 push，分布式 Worker 会改用标准 `clone / pull / push` 流程。

推荐配置项：

```json
{
  "gitEnabled": true,
  "gitDefaultBranch": "main",
  "gitRemoteUrl": "",
  "gitAuthorName": "TeamClaw",
  "gitAuthorEmail": "teamclaw@local"
}
```

设计上的默认体验是：

1. Controller 在项目启动/首个任务前准备好 workspace repo。
2. Worker 接任务前自动 sync repo。
3. 分布式 Worker 在任务结束后自动 publish 变更。
4. 如果远端 repo 不可用，Controller 会自动回落到 bundle 同步，而不是直接丢失协作能力。

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
bash tests/run-tests.sh --single-instance  # 单实例 Controller + local roles
```

`tests/test-api.sh` 现已覆盖 clarification loop：会验证 `blocked -> answered -> resumed`，并检查 Web UI 是否暴露 clarification 标签页。

如需让测试环境具备“可自带工具去 provision 外部依赖”的能力，可打开 host provisioning 模式：

```bash
TEAMCLAW_TEST_HOST_PROVISIONING=1 \
TEAMCLAW_TEST_DOCKER_SOCK=/var/run/docker.sock \
TEAMCLAW_TEST_KUBECONFIG=$HOME/.kube/config \
bash tests/run-tests.sh --single-instance
```

该模式会把 TeamClaw 测试容器切到 `root + privileged`，并按需挂载宿主 Docker socket / kubeconfig，便于角色在容器内自行安装并使用 `docker`、`kubectl` 等 CLI 去拉起共享 Git 服务、issue tracker、部署环境或其它 benchmark 依赖。它默认不是开启状态；真实部署时建议由宿主编排层显式传入标准环境变量与挂载，例如 `DOCKER_HOST`、`DOCKER_CONFIG`、`KUBECONFIG` 以及具体外部服务的地址/凭据。

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
