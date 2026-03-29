#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# S4: Docker Dynamic Provision — Controller container + Docker API
# ============================================================
# Controller container uses docker.sock to dynamically create
# worker containers via DockerProvisioner.
#
# The custom image has teamclaw baked in with a build-time patch
# that disables the auto bind mount when TEAMCLAW_BAKED_IN=true,
# since the Docker daemon cannot resolve container-internal paths.
#
# Usage: bash tests/test-docker-dynamic.sh [--skip-build]
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.s4.test.yml"
CONFIG_DIR="${PROJECT_ROOT}/tests/config/docker-dynamic"
IMAGE_NAME="${OPENCLAW_IMAGE:-registry.iot2.win/openclaw:teamclaw-test}"
SKIP_BUILD=false
PORT="${CONTROLLER_PORT:-9527}"
BASE_URL="http://localhost:${PORT}"
CONTROLLER_NAME="tc-s4-controller"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; }
log_info() { echo -e "  ${CYAN}INFO${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }

# Parse args
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ----------------------------------------------------------
# Pre-flight checks
# ----------------------------------------------------------
DOCKERFILE="${PROJECT_ROOT}/Dockerfile.teamclaw"
if [ ! -f "$DOCKERFILE" ]; then
  log_fail "Dockerfile.teamclaw not found at ${DOCKERFILE}"
  exit 1
fi

if [ -z "${ZAI_API_KEY:-}" ]; then
  log_fail "ZAI_API_KEY environment variable is required"
  exit 1
fi

# ----------------------------------------------------------
docker_compose() {
  OPENCLAW_PLATFORM="${OPENCLAW_PLATFORM:-linux/arm64}" \
  OPENCLAW_IMAGE="$IMAGE_NAME" \
  TEAMCLAW_CONTROLLER_CONFIG_DIR="$CONFIG_DIR" \
  TEST_ENV_FILE="${SCRIPT_DIR}/.env" \
  docker compose -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  local exit_code=$?
  log_info "Cleaning up..."
  docker_compose --progress=quiet down -v 2>/dev/null || true

  # Also remove any managed worker containers
  docker ps -a --filter "label=teamclaw.managed=true" --format "{{.Names}}" 2>/dev/null | while read -r name; do
    log_info "Removing managed container: ${name}"
    docker rm -f "$name" 2>/dev/null || true
  done

  # Remove persisted team state so subsequent runs start fresh
  rm -f "${CONFIG_DIR}/plugins/teamclaw/"*-team-state.json 2>/dev/null || true

  # Kill any stray openclaw processes on the controller port
  # (left behind by S1/S2 local test runs — process provisioner creates
  # detached gateway processes that survive parent exit).
  # Only target openclaw processes to avoid killing Docker daemon.
  if command -v lsof &>/dev/null; then
    for pid in $(lsof -ti :"${PORT}" 2>/dev/null); do
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || echo "")
      case "$cmd" in
        *openclaw*) kill -9 "$pid" 2>/dev/null || true ;;
      esac
    done
  fi

  exit $exit_code
}

trap cleanup EXIT

# ----------------------------------------------------------
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║  S4: Docker Dynamic Provision Test             ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Compose:    ${COMPOSE_FILE}"
echo "  Config:     ${CONFIG_DIR}"
echo "  Image:      ${IMAGE_NAME}"
echo "  Port:       ${PORT}"
echo ""

# ----------------------------------------------------------
# Step 1: Build image (optional)
# ----------------------------------------------------------
if [ "$SKIP_BUILD" != true ]; then
  echo -e "${BOLD}[1/7]${NC} Building Docker image..."
  docker build \
    --platform "${OPENCLAW_PLATFORM:-linux/amd64}" \
    -t "$IMAGE_NAME" \
    -f "$DOCKERFILE" \
    "$PROJECT_ROOT"

  if [ $? -eq 0 ]; then
    log_pass "Image built successfully"
  else
    log_fail "Image build failed"
    exit 1
  fi

  if [ "${DOCKER_PUSH:-}" = "1" ]; then
    log_info "Pushing image..."
    docker push "$IMAGE_NAME" || log_warn "Push failed (non-fatal)"
  fi
else
  echo -e "${BOLD}[1/7]${NC} ${YELLOW}Skipping build (--skip-build).${NC}"
  if ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
    log_fail "Image ${IMAGE_NAME} not found locally. Build first without --skip-build."
    exit 1
  fi
  log_pass "Image ${IMAGE_NAME} found locally"
fi

# ----------------------------------------------------------
# Step 2: Start controller container
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[2/7]${NC} Starting controller container..."

docker_compose --progress=quiet down -v 2>/dev/null || true
docker network rm teamclaw-s4-net 2>/dev/null || true

# Remove persisted team state so this run starts fresh
rm -f "${CONFIG_DIR}/plugins/teamclaw/"*-team-state.json 2>/dev/null || true

# Remove old controller session files so the LLM doesn't think
# requirements have already been processed (causes NO_REPLY)
rm -f "${CONFIG_DIR}/agents/main/sessions/"*.jsonl 2>/dev/null || true

# Kill any stray openclaw processes on the controller port
# (left behind by S1/S2 process provisioner — they bind to 0.0.0.0:9527
# even after the parent openclaw process exits, because detached:true).
# Only target openclaw processes to avoid killing Docker daemon.
if command -v lsof &>/dev/null; then
  for pid in $(lsof -ti :"${PORT}" 2>/dev/null); do
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || echo "")
    case "$cmd" in
      *openclaw*) kill -9 "$pid" 2>/dev/null || true ;;
    esac
  done
fi

docker_compose up -d

sleep 3

CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTROLLER_NAME" 2>/dev/null || echo "not found")
if [ "$CONTAINER_STATUS" = "running" ]; then
  log_pass "Controller container running"
else
  log_fail "Controller not running (status: ${CONTAINER_STATUS})"
  docker logs "$CONTROLLER_NAME" --tail 30 2>/dev/null || true
  exit 1
fi

# ----------------------------------------------------------
# Step 3: Wait for controller healthy
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[3/7]${NC} Wait for controller healthy..."

for i in $(seq 1 60); do
  if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
    break
  fi
  CONTAINER_STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTROLLER_NAME" 2>/dev/null || echo "unknown")
  if [ "$CONTAINER_STATUS" = "exited" ] || [ "$CONTAINER_STATUS" = "dead" ]; then
    log_fail "Controller exited/crashed (status: ${CONTAINER_STATUS})"
    echo ""
    docker logs "$CONTROLLER_NAME" --tail 50 2>/dev/null || true
    exit 1
  fi
  sleep 2
done

if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
  log_pass "Controller is healthy"
else
  log_fail "Controller did not become healthy within 120s"
  docker logs "$CONTROLLER_NAME" --tail 50 2>/dev/null || true
  exit 1
fi

# ----------------------------------------------------------
# Step 4: Verify docker.sock and teamclaw plugin
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[4/7]${NC} Verify docker.sock and teamclaw plugin..."

SOCK_LS=$(docker exec "$CONTROLLER_NAME" ls -la /var/run/docker.sock 2>/dev/null || echo "")
if echo "$SOCK_LS" | grep -q "srw"; then
  log_pass "docker.sock accessible in controller"
else
  log_fail "docker.sock not accessible in controller"
fi

PLUGIN_CHECK=$(docker exec "$CONTROLLER_NAME" ls /app/extensions/teamclaw/openclaw.plugin.json 2>/dev/null || echo "")
if [ -n "$PLUGIN_CHECK" ]; then
  log_pass "teamclaw plugin found in controller (/app/extensions/teamclaw/)"
else
  log_fail "teamclaw plugin NOT found in controller"
  docker exec "$CONTROLLER_NAME" ls -la /app/extensions/ 2>/dev/null | head -10 || true
fi

# Verify TEAMCLAW_BAKED_IN env is set
BAKED_IN=$(docker exec "$CONTROLLER_NAME" printenv TEAMCLAW_BAKED_IN 2>/dev/null || echo "")
if [ "$BAKED_IN" = "true" ]; then
  log_pass "TEAMCLAW_BAKED_IN=true is set in controller"
else
  log_warn "TEAMCLAW_BAKED_IN not set (may use default behavior)"
fi

# ----------------------------------------------------------
# Step 5: Wait for dynamically provisioned workers
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[5/7]${NC} Wait for dynamically provisioned workers..."

log_info "Waiting up to 90s for 3 docker workers to register..."
WORKERS_READY=false
READY_COUNT=0
for i in $(seq 1 45); do
  STATUS=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "")
  if [ -z "$STATUS" ]; then
    sleep 2
    continue
  fi

  READY_COUNT=$(echo "$STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
count = 0
for w in data.get('workers', []):
    if w.get('status') in ('ready', 'idle'):
        count += 1
print(count)
" 2>/dev/null || echo "0")

  if [ "$READY_COUNT" -ge 3 ]; then
    WORKERS_READY=true
    log_pass "All 3 docker workers registered (${READY_COUNT}/3)"
    break
  fi

  if [ $((i % 5)) -eq 0 ]; then
    log_info "  ${READY_COUNT}/3 workers ready... (${i}*2s elapsed)"
  fi

  sleep 2
done

if [ "$WORKERS_READY" != true ]; then
  log_fail "Only ${READY_COUNT}/3 workers registered after 90s"
  echo ""
  log_info "Team status dump:"
  curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
  echo ""
  log_info "Managed containers:"
  docker ps -a --filter "label=teamclaw.managed=true" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || echo "  (none)"
  echo ""
  log_info "Controller logs (last 30 lines):"
  docker logs "$CONTROLLER_NAME" --tail 30 2>/dev/null || true
fi

# ----------------------------------------------------------
# Step 6: Verify teamclaw plugin in worker containers
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[6/7]${NC} Verify teamclaw plugin in worker containers..."

WORKER_CONTAINER=$(docker ps --filter "label=teamclaw.managed=true" --filter "label=teamclaw.role=developer" --format "{{.Names}}" 2>/dev/null | head -1)
if [ -n "$WORKER_CONTAINER" ]; then
  WORKER_PLUGIN=$(docker exec "$WORKER_CONTAINER" ls /app/extensions/teamclaw/openclaw.plugin.json 2>/dev/null || echo "")
  if [ -n "$WORKER_PLUGIN" ]; then
    log_pass "teamclaw plugin found in worker ${WORKER_CONTAINER}"
  else
    log_fail "teamclaw plugin NOT found in worker ${WORKER_CONTAINER}"
    docker exec "$WORKER_CONTAINER" ls -la /app/extensions/ 2>/dev/null | head -10 || true
    docker exec "$WORKER_CONTAINER" ls -la /app/extensions/teamclaw/ 2>/dev/null | head -10 || true
  fi

  # Check no broken bind mount
  WORKER_MOUNTS=$(docker inspect "$WORKER_CONTAINER" --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' 2>/dev/null)
  TEAMCLAW_MOUNT=$(echo "$WORKER_MOUNTS" | grep teamclaw || echo "")
  if [ -n "$TEAMCLAW_MOUNT" ]; then
    log_info "Teamclaw mounts in worker:"
    echo "$TEAMCLAW_MOUNT"
  else
    log_pass "No extra teamclaw bind mount in worker (correct — using baked-in files)"
  fi
else
  log_info "No developer worker container found for plugin check"
fi

# ----------------------------------------------------------
# Step 7: Run full API test suite
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[7/8]${NC} Run full API test suite..."

if [ "$WORKERS_READY" = true ] && [ -f "${SCRIPT_DIR}/test-api.sh" ]; then
  bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "distributed"
else
  if [ "$WORKERS_READY" != true ]; then
    log_warn "Skipping API tests (workers not ready)"
  else
    log_warn "test-api.sh not found"
  fi
fi

# ----------------------------------------------------------
# Step 8: Run E2E delivery test (LLM-powered)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[8/8]${NC} Run E2E delivery test..."

REQUIREMENT_FILE="${SCRIPT_DIR}/requirements/s4-hospital-system.md"
if [ "$WORKERS_READY" = true ] && [ -f "${SCRIPT_DIR}/test-e2e-delivery.sh" ] && [ -f "$REQUIREMENT_FILE" ]; then
  bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "$REQUIREMENT_FILE" "distributed" 900
else
  if [ "$WORKERS_READY" != true ]; then
    log_warn "Skipping E2E delivery test (workers not ready)"
  else
    log_warn "test-e2e-delivery.sh or requirement file not found"
  fi
fi

# ----------------------------------------------------------
echo ""
if [ "$WORKERS_READY" = true ]; then
  echo -e "${BOLD}${GREEN}S4: Docker Dynamic Provision test PASSED.${NC}"
else
  echo -e "${BOLD}${RED}S4: Docker Dynamic Provision test FAILED.${NC}"
  exit 1
fi
