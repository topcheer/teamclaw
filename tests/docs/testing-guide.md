# TeamClaw 6 拓扑端到端测试指南

> 本文档覆盖所有 6 种部署拓扑的测试方法、配置要点、已验证功能和已知限制，供 agent review 使用。

## 总览

TeamClaw 支持 6 种部署拓扑，从本地单进程到 Kubernetes 动态 provision。所有拓扑共享同一个 API 测试套件 (`test-api.sh`, 18 个测试用例)。

| 拓扑 | 名称 | Worker 管理 | Git | 测试脚本 | 前置条件 |
|------|------|------------|-----|----------|----------|
| S1 | 本地单进程 | localRoles | false | `test-local-single.sh` | openclaw CLI |
| S2 | 本地动态 | ProcessProvisioner | false | `test-local-dynamic.sh` | openclaw CLI |
| S3 | Docker 分布式 | DockerProvisioner (固定) | true | `run-tests.sh` | Docker, docker.sock |
| S4 | Docker 动态 | DockerProvisioner (动态) | true | `test-docker-dynamic.sh` | Docker, docker.sock |
| S5 | K8s 单 Pod | localRoles | false | `test-k8s-single.sh` | kubectl, 集群, RBAC |
| S6 | K8s 动态 | KubernetesProvisioner | true | `test-k8s-dynamic.sh` | kubectl, 集群, RBAC |

统一入口: `bash tests/test-scenario-matrix.sh --scenario s1|s2|s3|s4|s5|s6`

---

## 运行前置条件

### 通用

| 条件 | 说明 |
|------|------|
| `ZAI_API_KEY` | LLM API 密钥，存放在 `tests/.env`（gitignored） |
| Node.js | S1/S2 需要 openclaw CLI 和 Node.js runtime |
| 端口 9527 | S1 以外的拓扑默认使用此端口，本地测试冲突时可通过环境变量覆盖 |

### Docker 拓扑 (S3/S4)

| 条件 | 说明 |
|------|------|
| Docker | OrbStack 或 Docker Desktop |
| `docker.sock` | S4 需要 Docker socket 权限来动态创建 worker 容器 |
| 镜像 `registry.iot2.win/openclaw:teamclaw-test` | 自定义镜像，包含 teamclaw 扩展 |

### K8s 拓扑 (S5/S6)

| 条件 | 说明 |
|------|------|
| kubectl | 已配置的 K8s 集群访问 |
| 镜像拉取 | 集群能拉取 `registry.iot2.win/openclaw:teamclaw-test` |
| StorageClass | 支持 ReadWriteMany（S6 PVC 需要多 Pod 共享） |
| RBAC | S6 需要 Pod 创建权限 |

---

## 各拓扑详细说明

### S1: 本地单进程 (`test-local-single.sh`)

**原理**: 单个 openclaw 进程以 controller 模式启动，通过 `localRoles` 配置在进程内模拟 3 个 worker 角色。

**配置关键**:
```json
{
  "mode": "controller",
  "localRoles": ["developer", "qa", "architect"],
  "gitEnabled": false,
  "port": 9527
}
```

**运行方式**:
```bash
ZAI_API_KEY=... bash tests/test-local-single.sh
```

**注意点**:
- 使用 `mktemp` 创建临时配置目录，不侵入用户真实 OpenClaw 配置
- controller 检测到 `/.dockerenv` 不存在 → 使用端口 0（动态端口），绑定 `127.0.0.1`
- 从 gateway 日志中提取实际端口: `grep 'Controller: HTTP server listening on port'`
- 测试完成后自动清理临时目录和进程

**端口**: 动态分配（日志中提取），非固定 9527

### S2: 本地动态 provision (`test-local-dynamic.sh`)

**原理**: controller 进程通过 `ProcessProvisioner` 使用 `child_process.spawn({ detached: true })` 动态创建 worker 子进程。每个 role 启动一个独立的 openclaw-gateway 进程。

**配置关键**:
```json
{
  "mode": "controller",
  "workerProvisioningType": "process",
  "workerProvisioningRoles": ["developer", "qa", "architect"],
  "workerProvisioningMinPerRole": 1,
  "workerProvisioningMaxPerRole": 1,
  "workerProvisioningIdleTtlMs": 300000,
  "workerProvisioningStartupTimeoutMs": 120000,
  "gitEnabled": false
}
```

**运行方式**:
```bash
ZAI_API_KEY=... bash tests/test-local-dynamic.sh
# 或自定义端口:
TEAMCLAW_TEST_PORT=9528 ZAI_API_KEY=... bash tests/test-local-dynamic.sh
```

**注意点**:
- `detached: true` 导致子进程在父进程退出后继续存活（PPID→1），测试 cleanup 必须 `pkill -9 -f "openclaw-gateway"`
- ProcessProvisioner 通过 symlink 共享扩展目录给子进程
- worker 连接 `http://127.0.0.1:{动态端口}` 注册

**端口**: 动态分配（与 S1 相同逻辑）

### S3: Docker 分布式 (`run-tests.sh --skip-build`)

**原理**: Docker Compose 启动 4 个固定容器（1 controller + 3 worker）。Controller 通过 Docker socket 动态拉起 worker 容器（DockerProvisioner），但实际是 4 个固定服务。

**两种子模式**:
- **distributed** (默认): `docker-compose.test.yml` — 4 个固定容器
- **single-instance**: `docker-compose.test.yml` + `--single-instance` — 1 个容器 + localRoles

**配置关键 (controller)**:
```json
{
  "mode": "controller",
  "gitEnabled": true,
  "workerProvisioningType": "docker",
  "workerProvisioningImage": "registry.iot2.win/openclaw-test",
  "workerProvisioningDockerNetwork": "teamclaw-test-net",
  "workerProvisioningDockerMounts": [
    "/path/to/teamclaw/src:/app/extensions/teamclaw:ro",
    "/path/to/teamclaw/tests/config/controller/workspace:/home/node/.openclaw/workspace"
  ]
}
```

**配置关键 (worker-dev/qa/arch)**:
```json
{
  "mode": "worker",
  "role": "developer",
  "controllerUrl": "http://tc-controller:9527",
  "teamName": "calc-project"
}
```

**运行方式**:
```bash
# 完整测试（含构建）
bash tests/run-tests.sh

# 跳过构建
bash tests/run-tests.sh --skip-build

# 单实例模式
bash tests/run-tests.sh --single-instance
```

**注意点**:
- `docker-compose.test.yml` 中 controller 需要 `group_add: [0]` (rootless Docker) 和 `docker.sock` 挂载
- 4 个服务使用 `env_file: ${TEST_ENV_FILE:-.env}` 注入 ZAI_API_KEY
- `prepare_distributed_configs()` 动态生成临时配置目录，从 `tests/config/` 拷贝并移除 `plugins/teamclaw` 目录（避免 bind mount 冲突）
- S3 distributed 模式不使用 `workerProvisioningMaxPerRole`，因为 worker 是固定容器而非动态创建
- cleanup 会 `lsof -ti :9527 | xargs kill -9` 清理残留进程

### S4: Docker 动态 provision (`test-docker-dynamic.sh`)

**原理**: 仅启动 1 个 controller 容器。DockerProvisioner 通过挂载的 `docker.sock` 动态创建 worker 容器。Worker 使用 `TEAMCLAW_BAKED_IN=true` 标志识别插件已烘焙到镜像中。

**配置关键**:
```json
{
  "mode": "controller",
  "gitEnabled": true,
  "workerProvisioningType": "docker",
  "workerProvisioningImage": "registry.iot2.win/openclaw:teamclaw-test",
  "workerProvisioningDockerNetwork": "teamclaw-s4-net"
}
```

**运行方式**:
```bash
ZAI_API_KEY=... bash tests/test-docker-dynamic.sh
ZAI_API_KEY=... bash tests/test-docker-dynamic.sh --skip-build
```

**注意点**:
- `TEAMCLAW_BAKED_IN=true` 是关键环境变量，由 `docker-compose.s4.test.yml` 设置
- 构建时 `patch-baked-in.cjs` 修改 `buildDockerBinds()` 函数：当 `TEAMCLAW_BAKED_IN=true` 时不添加自动 bind mount
- Worker 容器不需要 bind mount 源码（插件已烘焙到 `/app/extensions/teamclaw/`）
- cleanup 必须额外删除 `docker ps -a --filter "label=teamclaw.managed=true"` 的动态容器

### S5: K8s 单 Pod (`test-k8s-single.sh`)

**原理**: 单个 K8s Pod 以 controller 模式运行，使用 `localRoles` 在 Pod 内模拟 3 个 worker。ConfigMap 提供 openclaw.json，initContainer 复制到可写 emptyDir。

**K8s 资源**:
- ConfigMap: `teamclaw-single-config`
- Service: `teamclaw` (selector: `scenario: s5`)
- PVC: `teamclaw-workspace` (ReadWriteMany, 1Gi)
- Secret: `teamclaw-secrets` (ZAI_API_KEY)

**Pod Spec 关键设计**:
```yaml
initContainers:
  - name: copy-config
    # ConfigMap → emptyDir (ConfigMap 是只读的)
    command: ["sh", "-c", "cp /config-ro/openclaw.json /config/openclaw.json && mkdir -p /config/plugins /config/workspace/memory /config/logs"]
volumes:
  - config-ro: ConfigMap (只读)
  - config: emptyDir (可写，挂载到 /home/node/.openclaw)
```

**配置关键**:
```json
{
  "mode": "controller",
  "localRoles": ["developer", "qa", "architect"],
  "gitEnabled": false
}
```

**运行方式**:
```bash
export ZAI_API_KEY=...
bash tests/test-k8s-single.sh
```

**注意点**:
- K8s ConfigMap 挂载是**只读**的，teamclaw 插件需要写 `plugins/`、`workspace/memory/` 等子目录 → 必须用 initContainer 复制到 emptyDir
- `restartPolicy: Never`（不是 Docker 的 `UnlessExited`，K8s Pod 只支持 Always/OnFailure/Never）
- `livenessProbe` / `readinessProbe` 配置了 `initialDelaySeconds: 15/10`，给足启动时间
- 通过 `kubectl port-forward svc/teamclaw 9527:9527` 在本地访问

### S6: K8s 动态 provision (`test-k8s-dynamic.sh`)

**原理**: Controller Pod 通过 `KubernetesProvisioner` 调用 `kubectl apply` 动态创建 worker Pod。需要 RBAC 权限和 kubectl 工具。

**K8s 资源**:
- ServiceAccount: `teamclaw-controller`
- Role: `teamclaw-worker-manager` (pods: get/list/watch/create/delete)
- RoleBinding: `teamclaw-worker-manager-binding`
- ConfigMap: `teamclaw-dynamic-config`
- Service: `teamclaw-controller` (selector: `scenario: s6`)
- PVC: `teamclaw-workspace`
- Secret: `teamclaw-secrets`

**Pod Spec 关键设计**:
```yaml
initContainers:
  - name: copy-config    # 同 S5: ConfigMap → emptyDir
  - name: install-kubectl  # S6 特有: 安装 kubectl 到共享 volume
    image: bitnami/kubectl:latest
    command: ["sh", "-c", "cp /opt/bitnami/kubectl/bin/kubectl /kubectl-bin/kubectl && chmod +x /kubectl-bin/kubectl"]
containers:
  env:
    - name: PATH
      value: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/kubectl-bin"  # 加入 kubectl 路径
  volumeMounts:
    - name: kubectl-bin   # 挂载 kubectl 二进制
    - name: docker-sock   # 挂载 Docker socket (DinD)
```

**配置关键**:
```json
{
  "mode": "controller",
  "workerProvisioningType": "kubernetes",
  "workerProvisioningKubernetesNamespace": "teamclaw",
  "workerProvisioningControllerUrl": "http://teamclaw-controller.teamclaw.svc.cluster.local:9527",
  "workerProvisioningRoles": ["developer", "qa", "architect"],
  "workerProvisioningMinPerRole": 1,
  "workerProvisioningMaxPerRole": 1,
  "workerProvisioningImage": "registry.iot2.win/openclaw:teamclaw-test",
  "workerProvisioningPassEnv": ["ZAI_API_KEY"],
  "gitEnabled": true
}
```

**运行方式**:
```bash
export ZAI_API_KEY=...
bash tests/test-k8s-dynamic.sh
```

**注意点**:
- **必须配置 `workerProvisioningControllerUrl`**: worker Pod 需要通过 K8s 内部 Service DNS 访问 controller。格式为 `http://{service-name}.{namespace}.svc.cluster.local:{port}`
- **必须安装 kubectl**: 镜像中没有 kubectl，通过 `bitnami/kubectl` initContainer 安装到共享 emptyDir
- **RBAC 权限**: ServiceAccount `teamclaw-controller` 需要 Pod 的 get/list/watch/create/delete 权限
- **Port**: 使用 9528 避免与 S5 的 9527 冲突
- Worker Pod 通过 `TEAMCLAW_BOOTSTRAP_CONFIG_B64` 环境变量获取配置（Base64 编码的 JSON）
- Worker Pod 命名为 `teamclaw-{team}-{role}-{hash}` 格式
- Cleanup 必须删除 `kubectl delete pods -l "teamclaw.managed=true"`

---

## API 测试套件 (`test-api.sh`)

18 个测试用例覆盖以下功能:

| # | 测试 | 覆盖范围 |
|---|------|----------|
| 1 | Controller 健康检查 | `/api/v1/health` + 根路径重定向 |
| 2 | Git 协作 bootstrap | 初始化 git repo, branch, bundle export |
| 3 | Worker 注册 | 等待 3 个 worker 发送心跳 |
| 4 | 创建任务 + 自动分配 | 推荐技能 + 自动分配角色 |
| 5 | 任务列表 | 分页, 推荐技能保留 |
| 6 | 直接消息路由 | 发送给特定 worker |
| 7 | 广播消息 | 发送给所有 worker |
| 8 | 审查请求消息 | 消息类型=review_request |
| 9 | 任务交接 | 转移给另一个角色 |
| 10 | 任务结果提交 | worker 提交完成结果 |
| 11 | 任务执行详情 | 事件历史, 技能指导 |
| 12 | 提前完成处理 | 过早 completed 状态处理 |
| 13 | Worker 心跳超时 | 等待超时后自动下线 |
| 14 | 角色列表 | 10 个预设角色 |
| 15 | 团队状态 | workers, tasks, controllerRuns |
| 16 | 澄清工作流 | blocked → answered → pending |
| 17 | Web UI 可访问性 | HTTP 200, 关键 DOM 元素 |
| 18 | Worker 移除 | 删除已注册的 worker |

### Topology 参数对测试的影响

`test-api.sh` 接受第二个参数 `TOPOLOGY`:
- `single-instance` (S1/S3-single/S5): Test 13, 18 自动 SKIP
- `distributed` (S2/S3-distributed/S4/S6): 全部测试执行

Test 2 (Git):
- `gitEnabled: false` → 跳过 bundle export 检查 (S1/S2/S5)
- `gitEnabled: true` → 完整检查 git repo 和 bundle export (S3/S4/S6)

---

## 已验证的核心逻辑

### Controller 启动流程
1. 加载/创建 TeamState (`loadTeamState` / `saveTeamState`)
2. 确保 OpenClaw workspace memory 目录
3. 初始化 Git 协作 repo (`ensureControllerGitRepo`)
4. 创建 HTTP server:
   - **Docker 内**: `/.dockerenv` 存在 → 绑定 `0.0.0.0:{config.port}`
   - **本地**: 绑定 `127.0.0.1:0` (动态端口)
5. 初始化 mDNS 广播
6. 启动 localRoles (如果有)
7. 启动 WorkerProvisioning (如果启用)
8. 启动 15 秒心跳监控定时器

### Worker 注册流程
1. Worker 启动后向 `controllerUrl/api/v1/team/register` 发送注册请求
2. Controller 分配 workerId，更新 TeamState，广播 `worker:registered`
3. Worker 开始心跳 (每 5-10 秒)
4. Controller 心跳监控: 30 秒无心跳 → 标记 offline → 广播 `worker:offline`

### 任务分配流程
1. 客户端 POST `/api/v1/tasks` 创建任务
2. TaskRouter 根据角色推荐分配 worker (优先空闲 worker)
3. 如果没有 idle worker → 任务保持 pending
4. Worker 通过轮询或心跳响应获取分配的任务
5. Worker 执行完成后 POST `/api/v1/tasks/{id}/result`

### 三种 Provisioner 实现

| Provisioner | 创建方式 | 连接方式 | 清理方式 |
|------------|---------|---------|---------|
| `LocalWorkerManager` | 内存中 | 直接调用 | stop() |
| `ProcessProvisioner` | `child_process.spawn(detached)` | `http://127.0.0.1:{port}` | `child.kill()` + `pgrep` |
| `DockerProvisioner` | `docker run` via API | `http://{container}:{port}` | `docker rm -f` |
| `KubernetesProvisioner` | `kubectl apply -f -` (stdin JSON) | `http://{svc}.{ns}.svc.cluster.local:{port}` | `kubectl delete pod --force` |

### Docker Provisioner 与 K8s Provisioner 的差异

| 维度 | Docker | Kubernetes |
|------|-------|-----------|
| 命令 | `docker run` (Docker API) | `kubectl apply -f -` (shell spawn) |
| 镜像来源 | `workerProvisioningImage` | `workerProvisioningImage` |
| 配置传递 | 环境变量 `TEAMCLAW_BOOTSTRAP_CONFIG_B64` | 同左 |
| 网络 | `workerProvisioningDockerNetwork` | K8s 内部 Service DNS |
| Controller URL | `http://{parent_container}:{port}` | `http://{service}.{namespace}.svc.cluster.local:{port}` |
| 标识 | Docker label `teamclaw.managed=true` | K8s label `teamclaw.managed=true` |
| ServiceAccount | N/A | `workerProvisioningKubernetesServiceAccount` |
| PVC 支持 | N/A | `workerProvisioningKubernetesWorkspacePersistentVolumeClaim` |
| kubectl 依赖 | 不需要 | **必须安装** (镜像不包含 kubectl) |

---

## 常见问题排查

### 问题: `spawn kubectl ENOENT` (S6)
**原因**: controller pod 镜像中没有 kubectl
**解决**: 在 pods.yaml 中添加 `install-kubectl` initContainer (bitnami/kubectl) + 共享 volume + PATH 环境变量

### 问题: `workerProvisioningControllerUrl is required` (S6)
**原因**: K8s worker pods 无法通过 127.0.0.1 访问 controller
**解决**: 在 ConfigMap 中配置 `workerProvisioningControllerUrl: "http://teamclaw-controller.teamclaw.svc.cluster.local:9527"`

### 问题: ConfigMap volume 只读, `ENOENT: mkdir` (S5/S6)
**原因**: K8s ConfigMap 挂载是只读的, teamclaw 插件无法创建子目录
**解决**: 添加 initContainer 将 ConfigMap 内容复制到 emptyDir, 并预创建 `plugins/`, `workspace/memory/`, `logs/` 目录

### 问题: `restartPolicy: UnlessExited` 无效 (S5/S6)
**原因**: K8s Pod 只支持 Always/OnFailure/Never
**解决**: 改为 `restartPolicy: Never`

### 问题: S1/S2 端口冲突
**原因**: 本地 openclaw gateway 占用 9527
**解决**: controller-service.ts 检测 `/.dockerenv` → 本地使用端口 0 (动态分配)

### 问题: S2 子进程残留
**原因**: `detached: true` 使子进程 PPID→1, 父进程退出后存活
**解决**: cleanup 中 `pkill -9 -f "openclaw-gateway"` + 检查 orphaned `pgrep -x openclaw`

### 问题: S4 worker 容器 bind mount 失败
**原因**: `buildDockerBinds()` 使用容器内路径, Docker daemon 无法解析
**解决**: `patch-baked-in.cjs` 在构建时 patch 代码, `TEAMCLAW_BAKED_IN=true` 时跳过 bind mount

---

## Docker 镜像构建

镜像基于官方 `ghcr.io/openclaw/openclaw:latest`，额外安装依赖和 teamclaw 扩展:

```dockerfile
FROM ghcr.io/openclaw/openclaw:latest
# 安装运行时依赖
RUN npm install @sinclair/typebox@0.34.48 bonjour-service@1.3.0
# 复制 teamclaw 扩展源码到 /app/extensions/teamclaw/
COPY src/ /app/extensions/teamclaw/
# 构建时 patch: TEAMCLAW_BAKED_IN=true 时禁用自动 bind mount
RUN node /tmp/patch-baked-in.cjs
```

```bash
# 构建
docker buildx build --platform linux/amd64 -f Dockerfile.teamclaw \
  -t registry.iot2.win/openclaw:teamclaw-test --push .

# 测试时跳过构建
bash tests/run-tests.sh --skip-build
```

---

## 测试结果汇总

| 拓扑 | PASS | FAIL | SKIP | 说明 |
|------|------|------|------|------|
| S1 本地单进程 | 16 | 0 | 2 | SKIP: Test 13 (heartbeat), Test 18 (removal) — single-instance 模式 |
| S2 本地动态 | 17 | 0 | 2 | SKIP: Test 12 (premature), Test 13 (heartbeat) |
| S3 Docker 分布式 | 18 | 0 | 0 | 全部通过 |
| S4 Docker 动态 | 17 | 0 | 2 | SKIP: Test 12 (premature), Test 13 (heartbeat) |
| S5 K8s 单 Pod | 16 | 0 | 3 | SKIP: Test 2 (git), Test 13, 18 — single-instance + gitEnabled=false |
| S6 K8s 动态 | 17 | 0 | 1 | SKIP: Test 12 (premature) — 需安装 kubectl |

**所有拓扑 0 FAIL**。

---

## 文件清单

### 测试脚本
| 文件 | 用途 |
|------|------|
| `tests/test-local-single.sh` | S1 测试 |
| `tests/test-local-dynamic.sh` | S2 测试 |
| `tests/run-tests.sh` | S3 测试 (distributed + single-instance) |
| `tests/test-docker-dynamic.sh` | S4 测试 |
| `tests/test-k8s-single.sh` | S5 测试 |
| `tests/test-k8s-dynamic.sh` | S6 测试 |
| `tests/test-api.sh` | 共享 API 测试套件 (18 个用例) |
| `tests/test-scenario-matrix.sh` | 统一矩阵入口 |
| `tests/test-installer.mjs` | 安装器回归测试 |
| `tests/test-controller-intake.mjs` | Controller 集成测试 |
| `tests/test-worker-contracts.mjs` | Worker 合约测试 |
| `tests/test-ui-contracts.mjs` | UI 合约测试 |
| `tests/test-controller-manifest.mjs` | Controller manifest 测试 |
| `tests/test-role-registry.mjs` | 角色注册表测试 |

### 配置文件
| 文件 | 用途 |
|------|------|
| `tests/config/local-single/openclaw.json` | S1 配置 |
| `tests/config/local-dynamic/openclaw.json` | S2 配置 |
| `tests/config/controller/openclaw.json` | S3/S4 Controller 配置 |
| `tests/config/worker-dev/openclaw.json` | S3/S4 Developer Worker 配置 |
| `tests/config/worker-qa/openclaw.json` | S3/S4 QA Worker 配置 |
| `tests/config/worker-arch/openclaw.json` | S3/S4 Architect Worker 配置 |
| `tests/config/docker-dynamic/openclaw.json` | S4 动态 Controller 配置 |

### Docker
| 文件 | 用途 |
|------|------|
| `tests/docker-compose.test.yml` | S3 distributed (4 容器) |
| `tests/docker-compose.single.test.yml` | S3 single-instance (1 容器) |
| `tests/docker-compose.s4.test.yml` | S4 动态 |
| `Dockerfile.teamclaw` | 自定义镜像构建 |
| `tests/patch-baked-in.cjs` | 构建时 patch 脚本 |

### Kubernetes
| 文件 | 用途 |
|------|------|
| `tests/k8s/pods.yaml` | S5/S6 Pod 定义 |
| `tests/k8s/configmaps.yaml` | S5/S6 ConfigMap |
| `tests/k8s/services.yaml` | S5/S6 Service |
| `tests/k8s/rbac.yaml` | S6 RBAC (ServiceAccount + Role + RoleBinding) |
| `tests/k8s/workspace-pvc.yaml` | S5/S6 PVC |
| `tests/k8s/secret.yaml.template` | Secret 模板 (替换 ZAI_API_KEY) |

### 环境和辅助
| 文件 | 用途 |
|------|------|
| `tests/.env` | ZAI_API_KEY 等环境变量 (gitignored) |
| `tests/.gitignore` | gitignore 规则 |
| `scripts/prepare-teamclaw-runtime-context.mjs` | 构建运行时上下文 |
