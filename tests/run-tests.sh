#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.test.yml"
IMAGE_NAME="registry.iot2.win/openclaw:teamclaw-test"
SKIP_BUILD=false
KEEP_CONTAINERS=false
EXPECTED_E2E_WORKERS=3
E2E_REQUIREMENT_FILE="${TEAMCLAW_E2E_REQUIREMENT_FILE:-${SCRIPT_DIR}/requirements/s3-markdown-blog.md}"
E2E_TIMEOUT="${TEAMCLAW_E2E_TIMEOUT:-900}"
TEAMCLAW_DISTRIBUTED_CONFIG_DIR=""
TEAMCLAW_CONTROLLER_CONFIG_DIR="${SCRIPT_DIR}/config/controller"
TEAMCLAW_DEV_CONFIG_DIR="${SCRIPT_DIR}/config/worker-dev"
TEAMCLAW_QA_CONFIG_DIR="${SCRIPT_DIR}/config/worker-qa"
TEAMCLAW_ARCH_CONFIG_DIR="${SCRIPT_DIR}/config/worker-arch"
BUILD_CONTEXT_ROOT=""
BUILD_CONTEXT_DIR=""
BUILD_CONTEXT_SUMMARY=""
BUILD_DOCKERFILE=""
TEAMCLAW_TEST_HOST_PROVISIONING="${TEAMCLAW_TEST_HOST_PROVISIONING:-false}"
TEAMCLAW_TEST_DOCKER_SOCK="${TEAMCLAW_TEST_DOCKER_SOCK:-}"
TEAMCLAW_TEST_KUBECONFIG="${TEAMCLAW_TEST_KUBECONFIG:-}"
TEAMCLAW_TEST_KUBE_CONTEXT="${TEAMCLAW_TEST_KUBE_CONTEXT:-}"
HOST_PROVISIONING_ENABLED=false
COMPOSE_OVERRIDE_FILE=""
COMPOSE_ARGS=(-f "$COMPOSE_FILE")

if [ -n "${OPENCLAW_PLATFORM:-}" ]; then
  OPENCLAW_PLATFORM="${OPENCLAW_PLATFORM}"
elif [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  OPENCLAW_PLATFORM="linux/arm64"
else
  OPENCLAW_PLATFORM="linux/amd64"
fi

HOST_CONTROLLER_PORT="${CONTROLLER_PORT:-9527}"
BASE_URL="http://localhost:${HOST_CONTROLLER_PORT}"
PRIMARY_CONTAINER="tc-controller"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --keep) KEEP_CONTAINERS=true ;;
    --help)
      echo "Usage: bash tests/run-tests.sh [--skip-build] [--keep]"
      echo ""
      echo "  --skip-build  Reuse existing Docker image (skip build)"
      echo "  --keep        Keep containers running after tests"
      echo ""
      echo "Environment:"
      echo "  TEAMCLAW_TEST_HOST_PROVISIONING=1   Run TeamClaw test containers as root+privileged"
      echo "  TEAMCLAW_TEST_DOCKER_SOCK=/path     Mount host Docker socket (defaults to /var/run/docker.sock when present)"
      echo "  TEAMCLAW_TEST_KUBECONFIG=/path      Mount kubeconfig into TeamClaw test containers"
      echo "  TEAMCLAW_TEST_KUBE_CONTEXT=name     Pass through a preferred Kubernetes context"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

is_truthy() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

if is_truthy "$TEAMCLAW_TEST_HOST_PROVISIONING" || [ -n "$TEAMCLAW_TEST_DOCKER_SOCK" ] || [ -n "$TEAMCLAW_TEST_KUBECONFIG" ]; then
  HOST_PROVISIONING_ENABLED=true
fi

if [ "$HOST_PROVISIONING_ENABLED" = true ] && [ -z "$TEAMCLAW_TEST_DOCKER_SOCK" ] && [ -S /var/run/docker.sock ]; then
  TEAMCLAW_TEST_DOCKER_SOCK="/var/run/docker.sock"
fi

prepare_distributed_configs() {
  TEAMCLAW_DISTRIBUTED_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-distributed-config.XXXXXX")"

  for name in controller worker-dev worker-qa worker-arch; do
    local target_dir="${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}/${name}"
    mkdir -p "${target_dir}"
    cp -R "${SCRIPT_DIR}/config/${name}/." "${target_dir}/"
    rm -rf "${target_dir}/plugins/teamclaw"
  done

  TEAMCLAW_CONTROLLER_CONFIG_DIR="${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}/controller"
  TEAMCLAW_DEV_CONFIG_DIR="${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}/worker-dev"
  TEAMCLAW_QA_CONFIG_DIR="${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}/worker-qa"
  TEAMCLAW_ARCH_CONFIG_DIR="${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}/worker-arch"

  node -e "
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('${TEAMCLAW_CONTROLLER_CONFIG_DIR}/openclaw.json', 'utf8'));
const tc = (cfg.plugins?.entries?.teamclaw?.config) ?? {};
Object.keys(tc).filter((k) => k.startsWith('workerProvisioning')).forEach((k) => delete tc[k]);
fs.writeFileSync('${TEAMCLAW_CONTROLLER_CONFIG_DIR}/openclaw.json', JSON.stringify(cfg, null, 2) + '\n');
"
}

prepare_runtime_build_context() {
  BUILD_CONTEXT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-runtime-build.XXXXXX")"
  BUILD_CONTEXT_SUMMARY="${BUILD_CONTEXT_ROOT}/summary.json"

  node "${PROJECT_ROOT}/scripts/prepare-teamclaw-runtime-context.mjs" --output-dir "${BUILD_CONTEXT_ROOT}" > "${BUILD_CONTEXT_SUMMARY}"

  BUILD_CONTEXT_DIR="$(python3 - "${BUILD_CONTEXT_SUMMARY}" <<'PY'
import json, pathlib, sys
summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(summary['contextDir'])
PY
)"

  BUILD_DOCKERFILE="$(python3 - "${BUILD_CONTEXT_SUMMARY}" <<'PY'
import json, pathlib, sys
summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(summary['dockerfilePath'])
PY
)"
}

prepare_host_provisioning_override() {
  if [ "$HOST_PROVISIONING_ENABLED" != true ]; then
    return
  fi

  if [ -n "$TEAMCLAW_TEST_DOCKER_SOCK" ] && [ ! -e "$TEAMCLAW_TEST_DOCKER_SOCK" ]; then
    echo -e "${RED}ERROR: TEAMCLAW_TEST_DOCKER_SOCK not found at ${TEAMCLAW_TEST_DOCKER_SOCK}${NC}"
    exit 1
  fi

  if [ -n "$TEAMCLAW_TEST_KUBECONFIG" ] && [ ! -f "$TEAMCLAW_TEST_KUBECONFIG" ]; then
    echo -e "${RED}ERROR: TEAMCLAW_TEST_KUBECONFIG not found at ${TEAMCLAW_TEST_KUBECONFIG}${NC}"
    exit 1
  fi

  COMPOSE_OVERRIDE_FILE="$(mktemp "${TMPDIR:-/tmp}/teamclaw-provisioning-compose.XXXXXX")"

  python3 - "$COMPOSE_OVERRIDE_FILE" "$TEAMCLAW_TEST_DOCKER_SOCK" "$TEAMCLAW_TEST_KUBECONFIG" "$TEAMCLAW_TEST_KUBE_CONTEXT" <<'PY'
import json, pathlib, sys
out_path = pathlib.Path(sys.argv[1])
docker_sock = sys.argv[2]
kubeconfig = sys.argv[3]
kube_context = sys.argv[4]
services = ["teamclaw-controller", "teamclaw-dev", "teamclaw-qa", "teamclaw-arch"]

def q(value: str) -> str:
    return json.dumps(value)

lines = ["services:"]
for service in services:
    lines.append(f"  {service}:")
    lines.append("    user: root")
    lines.append("    privileged: true")
    lines.append("    environment:")
    lines.append(f"      TEAMCLAW_HOST_PROVISIONING: {q('1')}")
    if docker_sock:
        lines.append(f"      DOCKER_HOST: {q('unix:///var/run/docker.sock')}")
    if kubeconfig:
        lines.append(f"      KUBECONFIG: {q('/root/.kube/config')}")
    if kube_context:
        lines.append(f"      KUBE_CONTEXT: {q(kube_context)}")
    volumes = []
    if docker_sock:
        volumes.append(f"{docker_sock}:/var/run/docker.sock")
    if kubeconfig:
        volumes.append(f"{kubeconfig}:/root/.kube/config:ro")
    if volumes:
        lines.append("    volumes:")
        for volume in volumes:
            lines.append(f"      - {q(volume)}")
out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

  COMPOSE_ARGS=(-f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE_FILE")
}

docker_compose() {
  OPENCLAW_PLATFORM="$OPENCLAW_PLATFORM" \
    TEST_ENV_FILE="${SCRIPT_DIR}/.env" \
    TEAMCLAW_CONTROLLER_CONFIG_DIR="$TEAMCLAW_CONTROLLER_CONFIG_DIR" \
    TEAMCLAW_DEV_CONFIG_DIR="$TEAMCLAW_DEV_CONFIG_DIR" \
    TEAMCLAW_QA_CONFIG_DIR="$TEAMCLAW_QA_CONFIG_DIR" \
    TEAMCLAW_ARCH_CONFIG_DIR="$TEAMCLAW_ARCH_CONFIG_DIR" \
    docker compose "${COMPOSE_ARGS[@]}" "$@"
}

cleanup() {
  local exit_code=$?
  if [ "$KEEP_CONTAINERS" = false ]; then
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    docker_compose --progress=quiet down -v 2>/dev/null || true
    echo -e "${GREEN}Cleanup complete.${NC}"
  else
    echo ""
    echo -e "${YELLOW}Containers kept running. To clean up manually:${NC}"
    if [ -n "$COMPOSE_OVERRIDE_FILE" ]; then
      echo "  OPENCLAW_PLATFORM=${OPENCLAW_PLATFORM} docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_OVERRIDE_FILE} down -v"
    else
      echo "  OPENCLAW_PLATFORM=${OPENCLAW_PLATFORM} docker compose -f ${COMPOSE_FILE} down -v"
    fi
  fi

  if [ -n "$TEAMCLAW_DISTRIBUTED_CONFIG_DIR" ] && [ -d "$TEAMCLAW_DISTRIBUTED_CONFIG_DIR" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -rf "$TEAMCLAW_DISTRIBUTED_CONFIG_DIR"
    else
      echo "  distributed configs preserved at: ${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}"
    fi
  fi
  if [ -n "$BUILD_CONTEXT_ROOT" ] && [ -d "$BUILD_CONTEXT_ROOT" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -rf "$BUILD_CONTEXT_ROOT"
    else
      echo "  runtime build context preserved at: ${BUILD_CONTEXT_ROOT}"
    fi
  fi
  if [ -n "$COMPOSE_OVERRIDE_FILE" ] && [ -f "$COMPOSE_OVERRIDE_FILE" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -f "$COMPOSE_OVERRIDE_FILE"
    else
      echo "  compose override preserved at: ${COMPOSE_OVERRIDE_FILE}"
    fi
  fi
  if command -v lsof &>/dev/null; then
    for pid in $(lsof -i :"${HOST_CONTROLLER_PORT}" -t 2>/dev/null); do
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || echo "")
      case "$cmd" in
        *openclaw*) kill -9 "$pid" 2>/dev/null || true ;;
      esac
    done
  fi
  exit $exit_code
}

prepare_host_provisioning_override
trap cleanup EXIT

echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║    TeamClaw Docker Integration Tests    ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Project root:  ${PROJECT_ROOT}"
echo "  Compose file:  ${COMPOSE_FILE}"
echo "  Image:         ${IMAGE_NAME}"
echo "  Skip build:    ${SKIP_BUILD}"
echo "  Keep containers: ${KEEP_CONTAINERS}"
echo "  Topology:      distributed external workers"
echo "  Platform:      ${OPENCLAW_PLATFORM}"
echo "  Base URL:      ${BASE_URL}"
echo "  Host provisioning: ${HOST_PROVISIONING_ENABLED}"
echo "  E2E requirement: $(basename "${E2E_REQUIREMENT_FILE}")"
echo ""

echo -e "${BOLD}[1/5]${NC} Running installer/controller/worker regression smoke..."
node "${SCRIPT_DIR}/test-installer.mjs"
node "${SCRIPT_DIR}/test-controller-intake.mjs"
node "${SCRIPT_DIR}/test-worker-contracts.mjs"
node "${SCRIPT_DIR}/test-ui-contracts.mjs"
echo -e "${GREEN}  Installer regression passed.${NC}"

echo ""
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${BOLD}[2/5]${NC} Preparing TeamClaw runtime build context..."
  prepare_runtime_build_context
  echo -e "${BOLD}[2/5]${NC} Building Docker image with TeamClaw extension..."
  docker build \
    --platform "${OPENCLAW_PLATFORM}" \
    --build-arg OPENCLAW_EXTENSIONS="teamclaw" \
    -t "$IMAGE_NAME" \
    -f "${BUILD_DOCKERFILE}" \
    "${BUILD_CONTEXT_DIR}"
  echo -e "${GREEN}  Image built successfully.${NC}"
else
  echo -e "${BOLD}[2/5]${NC} ${YELLOW}Skipping build (reusing existing image).${NC}"
fi

echo ""
echo -e "${BOLD}[3/5]${NC} Starting distributed Docker cluster (1 controller + 3 external workers)..."
prepare_distributed_configs
docker_compose --progress=quiet down -v 2>/dev/null || true
if command -v lsof &>/dev/null; then
  for pid in $(lsof -i :"${HOST_CONTROLLER_PORT}" -t 2>/dev/null); do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || echo "")
    case "$cmd" in
      *openclaw*) kill "$pid" 2>/dev/null || true ;;
      *) echo -e "  ${YELLOW}WARNING: Port ${HOST_CONTROLLER_PORT} occupied by non-openclaw process PID ${pid}; skipping${NC}" ;;
    esac
  done
  sleep 1
fi
OPENCLAW_IMAGE="$IMAGE_NAME" docker_compose up -d

echo ""
echo -e "${BOLD}[4/5]${NC} Waiting for controller + workers..."
for i in $(seq 1 60); do
  HEALTH_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$PRIMARY_CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$HEALTH_STATUS" = "healthy" ] || curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
    echo -e "${GREEN}  Controller is healthy.${NC}"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo -e "${RED}  Controller did not become healthy!${NC}"
    docker logs "$PRIMARY_CONTAINER" --tail 80 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

for i in $(seq 1 30); do
  WORKER_COUNT="$(curl -sf --max-time 5 "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('workers', [])))" 2>/dev/null || echo 0)"
  if [ "${WORKER_COUNT:-0}" -ge 3 ]; then
    echo -e "${GREEN}  ${WORKER_COUNT} workers registered.${NC}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}  Timed out waiting for workers.${NC}"
    docker logs "$PRIMARY_CONTAINER" --tail 80 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

echo ""
echo -e "${BOLD}[5/5]${NC} Running API tests..."
bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "distributed"

echo ""
echo -e "${BOLD}[6/6]${NC} Running E2E delivery test..."
echo -e "${CYAN}  Resetting Docker cluster before E2E to avoid carried state...${NC}"
docker_compose --progress=quiet down -v 2>/dev/null || true
rm -rf "$TEAMCLAW_DISTRIBUTED_CONFIG_DIR"
TEAMCLAW_DISTRIBUTED_CONFIG_DIR=""
prepare_distributed_configs
OPENCLAW_IMAGE="$IMAGE_NAME" docker_compose up -d

for i in $(seq 1 60); do
  HEALTH_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$PRIMARY_CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$HEALTH_STATUS" = "healthy" ] || curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
    echo -e "${GREEN}  Fresh controller is healthy for E2E.${NC}"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo -e "${RED}  Controller did not become healthy before E2E!${NC}"
    docker logs "$PRIMARY_CONTAINER" --tail 80 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

for i in $(seq 1 30); do
  WORKER_COUNT="$(curl -sf --max-time 5 "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('workers', [])))" 2>/dev/null || echo 0)"
  if [ "${WORKER_COUNT:-0}" -ge "$EXPECTED_E2E_WORKERS" ]; then
    echo -e "${GREEN}  ${WORKER_COUNT} worker(s) registered for E2E.${NC}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}  Timed out waiting for workers before E2E.${NC}"
    docker logs "$PRIMARY_CONTAINER" --tail 80 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

REPO_BODY="$(curl -sf --max-time 10 "${BASE_URL}/api/v1/repo" 2>/dev/null || echo "{}")"
REPO_ENABLED="$(echo "$REPO_BODY" | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('repo',{}).get('enabled') else 'false')" 2>/dev/null || echo "false")"
REPO_BRANCH="$(echo "$REPO_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('repo',{}).get('defaultBranch',''))" 2>/dev/null || echo "")"
if [ "$REPO_ENABLED" != "true" ] || [ -z "$REPO_BRANCH" ]; then
  echo -e "${RED}  Git repo bootstrap failed before E2E.${NC}"
  echo "$REPO_BODY"
  exit 1
fi

bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "${E2E_REQUIREMENT_FILE}" "distributed" "${E2E_TIMEOUT}"
