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
#   bash tests/run-tests.sh           # full cycle
#   bash tests/run-tests.sh --skip-build  # reuse existing image
#   bash tests/run-tests.sh --keep        # don't tear down after tests
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_DIR="${PROJECT_ROOT}/openclaw"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.test.yml"
IMAGE_NAME="openclaw:teamclaw-test"
SKIP_BUILD=false
KEEP_CONTAINERS=false

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
    --help)
      echo "Usage: bash tests/run-tests.sh [--skip-build] [--keep]"
      echo ""
      echo "  --skip-build  Reuse existing Docker image (skip build)"
      echo "  --keep        Keep containers running after tests"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

cleanup() {
  local exit_code=$?
  if [ "$KEEP_CONTAINERS" = false ]; then
    echo ""
    echo -e "${YELLOW}Cleaning up...${NC}"
    docker compose -f "$COMPOSE_FILE" --progress=quiet down -v 2>/dev/null || true
    echo -e "${GREEN}Cleanup complete.${NC}"
  else
    echo ""
    echo -e "${YELLOW}Containers kept running. To clean up manually:${NC}"
    echo "  docker compose -f ${COMPOSE_FILE} down -v"
  fi
  exit $exit_code
}

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
echo ""

# ============================================================
# Step 1: Build Docker image
# ============================================================
if [ "$SKIP_BUILD" = false ]; then
  echo -e "${BOLD}[1/4]${NC} Preparing teamclaw extension for Docker build..."

  # Ensure teamclaw extension exists in openclaw/extensions/ as physical files
  # (Docker COPY cannot follow symlinks outside the build context)
  if [ -L "${OPENCLAW_DIR}/extensions/teamclaw" ]; then
    echo -e "  Removing symlink and creating physical copy..."
    rm -f "${OPENCLAW_DIR}/extensions/teamclaw"
  fi

  if [ ! -d "${OPENCLAW_DIR}/extensions/teamclaw" ]; then
    echo -e "  Copying src/ to openclaw/extensions/teamclaw/..."
    cp -r "${PROJECT_ROOT}/src" "${OPENCLAW_DIR}/extensions/teamclaw"
  fi

  if [ ! -f "${OPENCLAW_DIR}/Dockerfile" ]; then
    echo -e "${RED}ERROR: Dockerfile not found at ${OPENCLAW_DIR}/Dockerfile${NC}"
    exit 1
  fi

  echo -e "${BOLD}[1/4]${NC} Building Docker image with teamclaw extension..."

  docker build \
    --build-arg OPENCLAW_EXTENSIONS="teamclaw" \
    -t "$IMAGE_NAME" \
    -f "${OPENCLAW_DIR}/Dockerfile" \
    "${OPENCLAW_DIR}/"

  echo -e "${GREEN}  Image built successfully.${NC}"
else
  echo -e "${BOLD}[1/4]${NC} ${YELLOW}Skipping build (reusing existing image).${NC}"
fi

# ============================================================
# Step 2: Start test cluster
# ============================================================
echo ""
echo -e "${BOLD}[2/4]${NC} Starting test cluster (1 Controller + 3 Workers)..."

# Ensure clean state
docker compose -f "$COMPOSE_FILE" --progress=quiet down -v 2>/dev/null || true

OPENCLAW_IMAGE="$IMAGE_NAME" docker compose -f "$COMPOSE_FILE" up -d

echo -e "${GREEN}  Containers started.${NC}"

# ============================================================
# Step 3: Wait for Controller healthy + Workers to register
# ============================================================
echo ""
echo -e "${BOLD}[3/4]${NC} Waiting for Controller to become healthy..."

# Use docker compose health check
if ! docker compose -f "$COMPOSE_FILE" --progress=quiet wait teamclaw-controller 2>/dev/null; then
  echo -e "${YELLOW}  'docker compose wait' not available, using manual health check...${NC}"
  for i in $(seq 1 60); do
    if curl -sf --max-time 3 "http://localhost:9527/api/v1/health" > /dev/null 2>&1; then
      echo -e "${GREEN}  Controller is healthy.${NC}"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo -e "${RED}  Controller did not become healthy!${NC}"
      echo -e "${YELLOW}  Dumping controller logs:${NC}"
      docker logs tc-controller --tail 50 2>/dev/null || true
      exit 1
    fi
    sleep 2
  done
else
  echo -e "${GREEN}  Controller is healthy.${NC}"
fi

# Show container status
echo ""
echo -e "${CYAN}Container status:${NC}"
docker compose -f "$COMPOSE_FILE" --progress=quiet ps 2>/dev/null || docker ps --filter "name=tc-" --format "  {{.Names}}: {{.Status}}" 2>/dev/null || true

# ============================================================
# Step 4: Run API tests
# ============================================================
echo ""
echo -e "${BOLD}[4/4]${NC} Running API tests..."
echo ""

bash "${SCRIPT_DIR}/test-api.sh" "http://localhost:9527"
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo -e "${BOLD}${GREEN}All tests passed!${NC}"
else
  echo -e "${BOLD}${RED}Some tests failed!${NC}"
  echo ""
  echo -e "${YELLOW}Controller logs (last 30 lines):${NC}"
  docker logs tc-controller --tail 30 2>/dev/null || true
  echo ""
  echo -e "${YELLOW}Worker logs (last 15 lines each):${NC}"
  for c in tc-worker-dev tc-worker-qa tc-worker-arch; do
    echo -e "  --- ${c} ---"
    docker logs "$c" --tail 15 2>/dev/null || echo "  (not found)"
    echo ""
  done
fi

exit $TEST_EXIT
