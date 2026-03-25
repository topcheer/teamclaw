#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# TeamClaw Docker Integration Test Runner
# ============================================================
# Builds the Docker image with teamclaw extension, starts the
# test cluster (1 Controller + 3 Workers), runs API tests,
# and cleans up.
#
# Usage:
#   bash tests/run-tests.sh                # full cycle
#   bash tests/run-tests.sh --skip-build   # reuse existing image
#   bash tests/run-tests.sh --keep         # don't tear down after tests
#   bash tests/run-tests.sh --single-instance  # controller + local roles in one container
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_DIR="${PROJECT_ROOT}/openclaw"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.test.yml"
IMAGE_NAME="openclaw:teamclaw-test"
SKIP_BUILD=false
KEEP_CONTAINERS=false
TOPOLOGY="distributed"
TEAMCLAW_SINGLE_CONFIG_DIR=""
TEAMCLAW_DISTRIBUTED_CONFIG_DIR=""
TEAMCLAW_CONTROLLER_CONFIG_DIR="${SCRIPT_DIR}/config/controller"
TEAMCLAW_DEV_CONFIG_DIR="${SCRIPT_DIR}/config/worker-dev"
TEAMCLAW_QA_CONFIG_DIR="${SCRIPT_DIR}/config/worker-qa"
TEAMCLAW_ARCH_CONFIG_DIR="${SCRIPT_DIR}/config/worker-arch"
OPENCLAW_PLATFORM="${OPENCLAW_PLATFORM:-linux/amd64}"
HOST_CONTROLLER_PORT="${CONTROLLER_PORT:-9527}"
BASE_URL="http://localhost:${HOST_CONTROLLER_PORT}"
HEALTH_SERVICE="teamclaw-controller"
PRIMARY_CONTAINER="tc-controller"
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
COMPOSE_ARGS=()

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --keep) KEEP_CONTAINERS=true ;;
    --single-instance) TOPOLOGY="single-instance" ;;
    --help)
      echo "Usage: bash tests/run-tests.sh [--skip-build] [--keep] [--single-instance]"
      echo ""
      echo "  --skip-build  Reuse existing Docker image (skip build)"
      echo "  --keep        Keep containers running after tests"
      echo "  --single-instance  Run controller + local roles in one OpenClaw container"
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

if [ "$TOPOLOGY" = "single-instance" ]; then
  COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.single.test.yml"
  HEALTH_SERVICE="teamclaw-single"
  PRIMARY_CONTAINER="tc-single"
fi

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

COMPOSE_ARGS=(-f "$COMPOSE_FILE")

prepare_single_instance_config() {
  TEAMCLAW_SINGLE_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-single-config.XXXXXX")"
  cp -R "${SCRIPT_DIR}/config/controller/." "${TEAMCLAW_SINGLE_CONFIG_DIR}/"
  rm -rf "${TEAMCLAW_SINGLE_CONFIG_DIR}/plugins/teamclaw"

  python3 - "${TEAMCLAW_SINGLE_CONFIG_DIR}/openclaw.json" <<'PY'
import json
import pathlib
import sys

config_path = pathlib.Path(sys.argv[1])
data = json.loads(config_path.read_text())
teamclaw = (
    data.setdefault("plugins", {})
        .setdefault("entries", {})
        .setdefault("teamclaw", {})
        .setdefault("config", {})
)

teamclaw["mode"] = "controller"
teamclaw["port"] = 9527
teamclaw["heartbeatIntervalMs"] = 5000
teamclaw["localRoles"] = ["developer", "qa", "architect"]
teamclaw.pop("role", None)
teamclaw.pop("controllerUrl", None)

config_path.write_text(json.dumps(data, indent=2) + "\n")
PY
}

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
}

prepare_runtime_build_context() {
  BUILD_CONTEXT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-runtime-build.XXXXXX")"
  BUILD_CONTEXT_SUMMARY="${BUILD_CONTEXT_ROOT}/summary.json"

  node "${PROJECT_ROOT}/scripts/prepare-teamclaw-runtime-context.mjs" --output-dir "${BUILD_CONTEXT_ROOT}" > "${BUILD_CONTEXT_SUMMARY}"

  BUILD_CONTEXT_DIR="$(python3 - "${BUILD_CONTEXT_SUMMARY}" <<'PY'
import json
import pathlib
import sys

summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(summary["contextDir"])
PY
)"

  BUILD_DOCKERFILE="$(python3 - "${BUILD_CONTEXT_SUMMARY}" <<'PY'
import json
import pathlib
import sys

summary = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(summary["dockerfilePath"])
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

  python3 - "$COMPOSE_OVERRIDE_FILE" "$TOPOLOGY" "$TEAMCLAW_TEST_DOCKER_SOCK" "$TEAMCLAW_TEST_KUBECONFIG" "$TEAMCLAW_TEST_KUBE_CONTEXT" <<'PY'
import json
import pathlib
import sys

out_path = pathlib.Path(sys.argv[1])
topology = sys.argv[2]
docker_sock = sys.argv[3]
kubeconfig = sys.argv[4]
kube_context = sys.argv[5]
services = ["teamclaw-single"] if topology == "single-instance" else [
    "teamclaw-controller",
    "teamclaw-dev",
    "teamclaw-qa",
    "teamclaw-arch",
]

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
    TEAMCLAW_SINGLE_CONFIG_DIR="$TEAMCLAW_SINGLE_CONFIG_DIR" \
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
    if [ -n "${COMPOSE_OVERRIDE_FILE}" ]; then
      echo "  docker compose -f ${COMPOSE_FILE} -f ${COMPOSE_OVERRIDE_FILE} down -v"
    else
      echo "  docker compose -f ${COMPOSE_FILE} down -v"
    fi
  fi
  if [ -n "${TEAMCLAW_SINGLE_CONFIG_DIR}" ] && [ -d "${TEAMCLAW_SINGLE_CONFIG_DIR}" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -rf "${TEAMCLAW_SINGLE_CONFIG_DIR}"
    else
      echo "  single-instance config preserved at: ${TEAMCLAW_SINGLE_CONFIG_DIR}"
    fi
  fi
  if [ -n "${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}" ] && [ -d "${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -rf "${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}"
    else
      echo "  distributed configs preserved at: ${TEAMCLAW_DISTRIBUTED_CONFIG_DIR}"
    fi
  fi
  if [ -n "${BUILD_CONTEXT_ROOT}" ] && [ -d "${BUILD_CONTEXT_ROOT}" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -rf "${BUILD_CONTEXT_ROOT}"
    else
      echo "  runtime build context preserved at: ${BUILD_CONTEXT_ROOT}"
    fi
  fi
  if [ -n "${COMPOSE_OVERRIDE_FILE}" ] && [ -f "${COMPOSE_OVERRIDE_FILE}" ]; then
    if [ "$KEEP_CONTAINERS" = false ]; then
      rm -f "${COMPOSE_OVERRIDE_FILE}"
    else
      echo "  compose override preserved at: ${COMPOSE_OVERRIDE_FILE}"
    fi
  fi
  exit $exit_code
}

prepare_host_provisioning_override

trap cleanup EXIT

# ============================================================
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║    TeamClaw Docker Integration Tests    ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Project root:  ${PROJECT_ROOT}"
echo "  OpenClaw dir:  ${OPENCLAW_DIR}"
echo "  Compose file:  ${COMPOSE_FILE}"
echo "  Image:         ${IMAGE_NAME}"
echo "  Skip build:    ${SKIP_BUILD}"
echo "  Keep containers: ${KEEP_CONTAINERS}"
echo "  Topology:      ${TOPOLOGY}"
echo "  Platform:      ${OPENCLAW_PLATFORM}"
echo "  Base URL:      ${BASE_URL}"
echo "  Host provisioning: ${HOST_PROVISIONING_ENABLED}"
echo "  Docker socket: ${TEAMCLAW_TEST_DOCKER_SOCK:-disabled}"
echo "  Kubeconfig:    ${TEAMCLAW_TEST_KUBECONFIG:-disabled}"
echo ""

# ============================================================
# Step 1: Run installer/controller/worker regression
# ============================================================
echo -e "${BOLD}[1/5]${NC} Running installer/controller/worker regression smoke..."
node "${SCRIPT_DIR}/test-installer.mjs"
node "${SCRIPT_DIR}/test-controller-intake.mjs"
node "${SCRIPT_DIR}/test-worker-contracts.mjs"
node "${SCRIPT_DIR}/test-ui-contracts.mjs"
echo -e "${GREEN}  Installer regression passed.${NC}"

# ============================================================
# Step 2: Build Docker image
# ============================================================
echo ""
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${BOLD}[2/5]${NC} Preparing teamclaw extension for Docker build..."

  if [ "$TOPOLOGY" = "single-instance" ]; then
    prepare_single_instance_config
  fi

  prepare_runtime_build_context

  if [ ! -f "${BUILD_DOCKERFILE}" ]; then
    echo -e "${RED}ERROR: generated Dockerfile not found at ${BUILD_DOCKERFILE}${NC}"
    exit 1
  fi

  echo -e "${BOLD}[2/5]${NC} Building Docker image with teamclaw extension..."
  echo -e "  Runtime build context: ${BUILD_CONTEXT_DIR}"

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

# ============================================================
# Step 3: Start test cluster
# ============================================================
echo ""
if [ "$TOPOLOGY" = "single-instance" ]; then
  echo -e "${BOLD}[3/5]${NC} Starting single-instance cluster (1 Controller + local roles)..."
else
  echo -e "${BOLD}[3/5]${NC} Starting test cluster (1 Controller + 3 Workers)..."
fi

if [ "$TOPOLOGY" = "single-instance" ] && [ -z "$TEAMCLAW_SINGLE_CONFIG_DIR" ]; then
  prepare_single_instance_config
fi
if [ "$TOPOLOGY" != "single-instance" ] && [ -z "$TEAMCLAW_DISTRIBUTED_CONFIG_DIR" ]; then
  prepare_distributed_configs
fi

# Ensure clean state
docker_compose --progress=quiet down -v 2>/dev/null || true

OPENCLAW_IMAGE="$IMAGE_NAME" docker_compose up -d

echo -e "${GREEN}  Containers started.${NC}"

# ============================================================
# Step 4: Wait for Controller healthy + Workers to register
# ============================================================
echo ""
echo -e "${BOLD}[4/5]${NC} Waiting for Controller to become healthy..."

for i in $(seq 1 60); do
  HEALTH_STATUS="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$PRIMARY_CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$HEALTH_STATUS" = "healthy" ] || curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
    echo -e "${GREEN}  Controller is healthy.${NC}"
    break
  fi
  if [ "$HEALTH_STATUS" = "exited" ] || [ "$HEALTH_STATUS" = "dead" ]; then
    echo -e "${RED}  Controller exited before becoming healthy!${NC}"
    echo -e "${YELLOW}  Dumping controller logs:${NC}"
    docker logs "$PRIMARY_CONTAINER" --tail 80 2>/dev/null || true
    exit 1
  fi
  if [ "$i" -eq 60 ]; then
    echo -e "${RED}  Controller did not become healthy!${NC}"
    echo -e "${YELLOW}  Dumping controller logs:${NC}"
    docker logs "$PRIMARY_CONTAINER" --tail 80 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

# Show container status
echo ""
echo -e "${CYAN}Container status:${NC}"
docker_compose --progress=quiet ps 2>/dev/null || docker ps --filter "name=tc-" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || true

# ============================================================
# Step 5: Run API tests
# ============================================================
echo ""
echo -e "${BOLD}[5/5]${NC} Running API tests..."
echo ""

bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "${TOPOLOGY}"
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo -e "${BOLD}${GREEN}All tests passed!${NC}"
else
  echo -e "${BOLD}${RED}Some tests failed!${NC}"
  echo ""
  echo -e "${YELLOW}Controller logs (last 30 lines):${NC}"
  docker logs "$PRIMARY_CONTAINER" --tail 30 2>/dev/null || true
  if [ "$TOPOLOGY" != "single-instance" ]; then
    echo ""
    echo -e "${YELLOW}Worker logs (last 15 lines each):${NC}"
    for c in tc-worker-dev tc-worker-qa tc-worker-arch; do
      echo -e "  --- ${c} ---"
      docker logs "$c" --tail 15 2>/dev/null || echo "  (not found)"
      echo ""
    done
  fi
fi

exit $TEST_EXIT
