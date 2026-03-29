# TeamClaw 测试策略与环境配置

> 本文档记录完整测试策略、环境配置、软件需求，可反复使用。

## 1. 测试目标

作为一个人类开发者，有复杂的软件开发需求，使用 TeamClaw 进行多角色协作开发。本次测试覆盖 TeamClaw 的全部 6 种部署拓扑，确保每种拓扑都能：
1. Controller 正常启动并暴露 API
2. Worker 正确注册并就绪
3. 18 个 API 测试全部通过（或合理 SKIP）
4. 能创建任务、分配给 worker、执行并返回结果

## 2. 六种部署拓扑

| # | 名称 | Controller | Worker 方式 | gitEnabled | 运行环境 |
|---|------|-----------|-----------|------------|----------|
| S1 | 本地单进程 | 本地 openclaw | localRoles (同进程) | false | 本地 macOS |
| S2 | 本地动态 provision | 本地 openclaw | process (子进程) | false | 本地 macOS |
| S3 | Docker 单进程 | Docker 容器 | localRoles (同容器) | false | SSH 13 Docker |
| S4 | Docker 分布式 | Docker 容器 | docker (Docker API) | true | SSH 13 Docker |
| S5 | K8s 单 Pod | K8s Pod | localRoles (同 Pod) | false | 本地 k3s |
| S6 | K8s 分布式 | K8s Pod | kubernetes (kubectl) | true | 本地 k3s |

## 3. 环境配置

### 3.1 基础工具

| 工具 | 版本/位置 | 用途 |
|------|----------|------|
| openclaw | OpenClaw 2026.3.24, /opt/homebrew/bin/openclaw | CLI 运行 gateway |
| openclaw dist | teamclaw/openclaw/dist/ (submodule) | Node.js 入口 |
| Docker | macOS + SSH 13 (docker23 context) | S3/S4 测试 |
| kubectl | k3s default context | S5/S6 测试 |
| Docker image | registry.iot2.win/openclaw:teamclaw-test | 统一镜像 |

### 3.2 Docker Context

```bash
# 切换到本地 Docker (S1/S2 不需要 Docker)
docker context use default

# 切换到 SSH 13 Docker (S3/S4)
docker context use docker23

# SSH 13 服务器: 192.168.31.23
# Docker 主机名: beedeb
```

### 3.3 Kubernetes Context

```bash
# k3s default context (S5/S6)
kubectl config current-context  # → default
kubectl get nodes  # → mach (v1.35.0+k3s1)
```

### 3.4 环境变量

所有 API 密钥统一在 `tests/.env` 中管理（已加入 .gitignore）：

```bash
# tests/.env
ZAI_API_KEY=31c52998b0ed4b5b873fae684573cbfa.1kPfC0iWOMMxs2tE
```

### 3.5 TeamClaw 插件

- 插件源码: `src/` 目录
- 自定义镜像烘焙插件到: `/app/extensions/teamclaw/`
- 构建时 patch: `tests/patch-baked-in.cjs` (TEAMCLAW_BAKED_IN 支持)
- Dockerfile: `Dockerfile.teamclaw`

### 3.6 镜像构建与推送

```bash
# 构建镜像 (platform=linux/amd64, SSH13 是 x86)
docker build --platform linux/amd64 \
  -t registry.iot2.win/openclaw:teamclaw-test \
  -f Dockerfile.teamclaw .

# 推送到 registry (需要 docker context docker23)
docker --context docker23 push registry.iot2.win/openclaw:teamclaw-test
```

## 4. 各拓扑启动方式

### S1: 本地单进程
```bash
OPENCLAW_HOME=tests/config/local-single \
  ZAI_API_KEY=$(grep ZAI_API_KEY tests/.env | cut -d= -f2) \
  node openclaw/dist/index.js gateway --allow-unconfigured --port 9527
```
- 验证: `curl -sf http://localhost:9527/api/v1/health`
- 停止: Ctrl+C 或 `kill <PID>`
- 测试: `bash tests/test-api.sh http://localhost:9527 single-instance`

### S2: 本地动态 provision
```bash
OPENCLAW_HOME=tests/config/local-dynamic \
  ZAI_API_KEY=$(grep ZAI_API_KEY tests/.env | cut -d= -f2) \
  node openclaw/dist/index.js gateway --allow-unconfigured --port 9527
```
- 验证: `curl -sf http://localhost:9527/api/v1/health`
- 等待 ~15s 让子进程启动
- 停止: Ctrl+C (主进程退出后子进程自动清理)
- 测试: `bash tests/test-api.sh http://localhost:9527 distributed`

### S3: Docker 单进程 (SSH 13)
```bash
# 切换 Docker context
docker context use docker23

# 构建或确认镜像存在
docker build --platform linux/amd64 -t registry.iot2.win/openclaw:teamclaw-test -f Dockerfile.teamclaw .
docker --context docker23 push registry.iot2.win/openclaw:teamclaw-test

# 运行单实例
OPENCLAW_PLATFORM=linux/amd64 \
  OPENCLAW_IMAGE=registry.iot2.win/openclaw:teamclaw-test \
  TEAMCLAW_SINGLE_CONFIG_DIR=tests/config/docker-single \
  bash tests/run-tests.sh --skip-build --single-instance
```
- 测试完成后自动清理

### S4: Docker 分布式 (SSH 13)
```bash
docker context use docker23

# 确保镜像已构建并推送
OPENCLAW_PLATFORM=linux/amd64 \
  OPENCLAW_IMAGE=registry.iot2.win/openclaw:teamclaw-test \
  TEAMCLAW_CONTROLLER_CONFIG_DIR=tests/config/controller \
  bash tests/run-tests.sh --skip-build
```
- 需要 docker.sock (controller 通过 Docker API 创建 worker)
- 测试完成后自动清理

### S5: K8s 单 Pod (本地 k3s)
```bash
# 确保镜像已在本地 k3s 可用
kubectl config use-context default

ZAI_API_KEY=$(grep ZAI_API_KEY tests/.env | cut -d= -f2) \
  bash tests/test-k8s-single.sh
```
- 需要 k3s 运行中
- 测试完成后自动清理

### S6: K8s 分布式 (本地 k3s)
```bash
kubectl config use-context default

ZAI_API_KEY=$(grep ZAI_API_KEY tests/.env | cut -d= -f2) \
  bash tests/test-k8s-dynamic.sh
```
- 需要 k3s 运行中 + docker.sock 挂载 (用于 K8sProvisioner)
- 测试完成后自动清理

## 5. 测试脚本清单

### 配置文件
| 文件 | 用途 | 拓扑 |
|------|------|------|
| `tests/config/local-single/openclaw.json` | S1 配置 | S1 |
| `tests/config/local-dynamic/openclaw.json` | S2 配置 | S2 |
| `tests/config/controller/openclaw.json` | S3 distributed / S4 base 配置 | S3/S4 |
| `tests/config/docker-single/` | S3 单实例配置目录 | S3 |
| `tests/config/docker-dynamic/openclaw.json` | S4 动态 provision 配置 | S4 |
| `tests/config/worker-dev/openclaw.json` | developer worker 配置 | S3 |
| `tests/config/worker-qa/openclaw.json` | QA worker 配置 | S3 |
| `tests/config/worker-arch/openclaw.json` | architect worker 配置 | S3 |
| `tests/k8s/configmaps.yaml` | S5/S6 ConfigMap | S5/S6 |
| `tests/k8s/pods.yaml` | S5/S6 Pod 定义 | S5/S6 |
| `tests/k8s/services.yaml` | S5/S6 Service 定义 | S5/S6 |
| `tests/k8s/rbac.yaml` | S6 RBAC | S6 |
| `tests/k8s/workspace-pvc.yaml` | S6 workspace PVC | S6 |
| `tests/k8s/secret.yaml.template` | K8s secret 模板 | S5/S6 |

### Docker Compose 文件
| 文件 | 用途 |
|------|------|
| `tests/docker-compose.test.yml` | S3 distributed (controller + 3 static workers) |
| `tests/docker-compose.single.test.yml` | S3 single-instance |
| `tests/docker-compose.s4.test.yml` | S4 动态 Docker provision |

### 测试脚本
| 文件 | 用途 |
|------|------|
| `tests/test-api.sh` | 18 个 API 测试（核心测试逻辑） |
| `tests/test-local-single.sh` | S1 测试入口 |
| `tests/test-local-dynamic.sh` | S2 测试入口 |
| `tests/run-tests.sh` | S3 测试入口（支持 distributed/single-instance） |
| `tests/test-docker-dynamic.sh` | S4 测试入口 |
| `tests/test-k8s-single.sh` | S5 测试入口 |
| `tests/test-k8s-dynamic.sh` | S6 测试入口 |
| `tests/test-scenario-matrix.sh` | 统一运行所有场景 |

### 构建文件
| 文件 | 用途 |
|------|------|
| `Dockerfile.teamclaw` | 自定义镜像构建 |
| `tests/patch-baked-in.cjs` | 构建时 patch TEAMCLAW_BAKED_IN |

## 6. API 测试清单 (test-api.sh 18 项)

| # | 测试名称 | 本地拓扑 | Docker 分布式 | K8s |
|---|---------|---------|-------------|------|
| 1 | Controller 健康检查 | PASS | PASS | PASS |
| 2 | Git 协作引导 | SKIP (gitEnabled=false) | PASS (gitEnabled=true) | PASS/SKIP |
| 3 | Worker 注册 (3个) | PASS | PASS | PASS |
| 4 | 创建任务+自动分配 | PASS | PASS | PASS |
| 5 | 获取任务列表 | PASS | PASS | PASS |
| 6 | 直接消息路由 | PASS | PASS | PASS |
| 7 | 广播消息 | PASS | PASS | PASS |
| 8 | 审查请求 | PASS | PASS | PASS |
| 9 | 任务交接 | PASS | PASS | PASS |
| 10 | 任务结果提交 | PASS | PASS | PASS |
| 11 | 任务执行详情 | PASS | PASS | PASS |
| 12 | 过早完成处理 | PASS | PASS | PASS |
| 13 | Worker 心跳超时 | SKIP | PASS | PASS |
| 14 | 角色列表 | PASS | PASS | PASS |
| 15 | 团队状态 | PASS | PASS | PASS |
| 16 | 澄清工作流 | PASS | PASS | PASS |
| 17 | Web UI 可访问性 | PASS | PASS | PASS |
| 18 | Worker 移除 | SKIP | PASS | PASS |

## 7. 清理命令

```bash
# 清理本地进程
pkill -f "openclaw.*gateway" 2>/dev/null

# 清理 SSH13 Docker 容器
docker --context docker23 ps -a --filter "name=tc-" -q | xargs docker --context docker23 rm -f 2>/dev/null
docker --context docker23 ps -a --filter "label=teamclaw.managed=true" -q | xargs docker --context docker23 rm -f 2>/dev/null

# 清理 K8s 资源
kubectl delete pod -l "teamclaw.managed=true" --ignore-not-found --grace-period=5 2>/dev/null
kubectl delete pod -l "scenario=s5" -n teamclaw --ignore-not-found --grace-period=5 2>/dev/null
kubectl delete pod -l "scenario=s6" -n teamclaw --ignore-not-found --grace-period=5 2>/dev/null
```

## 8. 故障排查

### 常见问题

1. **端口 9527 被占用**: `lsof -i :9527` 检查，`kill <PID>` 清理
2. **Docker context 错误**: S3/S4 必须用 `docker23`，S1/S2 用 `default`
3. **K8s 镜像拉取失败**: 确保 registry.iot2.win 镜像已推送到 k3s 可访问的 registry
4. **Git 测试 SKIP**: 本地拓扑/localRoles 模式下 gitEnabled=false 是正确的，SKIP 属于预期行为
5. **Worker 未注册**: 检查网络连通性、环境变量、controller 日志

### 日志查看

```bash
# Docker 容器日志
docker --context docker23 logs tc-controller --tail 50
docker --context docker23 logs tc-worker-dev --tail 50

# K8s Pod 日志
kubectl logs -n teamclaw <pod-name> --tail 50
```
