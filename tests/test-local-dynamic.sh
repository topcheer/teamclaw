#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# S2: Local Dynamic Provision — Controller + spawned child processes
# ============================================================
# Starts a controller process that dynamically spawns
# worker child processes via ProcessProvisioner.
#
# Uses temporary config + workspace + --profile so nothing
# invades the user's real OpenClaw home.
#
# Usage: bash tests/test-local-dynamic.sh
#   ZAI_API_KEY=... bash tests/test-local-dynamic.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="${PROJECT_ROOT}/src"
OPENCLAW_BIN="$(command -v openclaw)"
PORT="${TEAMCLAW_TEST_PORT:-9527}"
CONTROLLER_PID=""
TEMP_DIR=""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; }
log_info() { echo -e "  ${CYAN}INFO${NC} $1"; }
log_skip() { echo -e "  ${YELLOW}SKIP${NC} $1"; }

cleanup() {
  local exit_code=$?
  # Kill controller first so it stops spawning new workers
  if [ -n "$CONTROLLER_PID" ]; then
    kill "$CONTROLLER_PID" 2>/dev/null || true
    wait "$CONTROLLER_PID" 2>/dev/null || true
    log_info "Controller process stopped (PID=$CONTROLLER_PID)"
  fi
  # Kill ALL openclaw-gateway processes (the pattern must be broad —
  # detached child processes survive parent exit and their command line
  # may not contain "--bind loopback" verbatim).
  pkill -9 -f "openclaw-gateway" 2>/dev/null || true
  # Also kill any orphaned openclaw processes (PPID=1) that the
  # process provisioner may have left behind.
  pgrep -x "openclaw" 2>/dev/null | while read -r pid; do
    if [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "1" ]; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
    log_info "Temp dir cleaned: ${TEMP_DIR}"
  fi
  exit $exit_code
}

trap cleanup EXIT

# Pre-flight: check openclaw CLI exists
if [ -z "$OPENCLAW_BIN" ]; then
  echo -e "${RED}ERROR: openclaw CLI not found.${NC}"
  exit 1
fi

# Pre-flight: check ZAI_API_KEY
if [ -z "${ZAI_API_KEY:-}" ]; then
  if [ -f "${SCRIPT_DIR}/.env" ]; then
    ZAI_API_KEY="$(grep ZAI_API_KEY "${SCRIPT_DIR}/.env" | cut -d= -f2-)"
  fi
fi
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo -e "${RED}ERROR: ZAI_API_KEY not set. Export it or add to tests/.env${NC}"
  exit 1
fi

# Pre-flight: check port available (kill stale openclaw processes first)
pkill -9 -f "openclaw-gateway" 2>/dev/null || true
sleep 1
if lsof -i ":${PORT}" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  echo -e "${RED}ERROR: Port ${PORT} is still in use after cleanup.${NC}"
  echo -e "${YELLOW}Tip: export TEAMCLAW_TEST_PORT=9528 to use a different port${NC}"
  exit 1
fi

# ----------------------------------------------------------
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║  S2: Local Dynamic Provision Test           ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ----------------------------------------------------------
# Prepare temporary config + workspace
# ----------------------------------------------------------
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-s2.XXXXXX")"
CONFIG_DIR="${TEMP_DIR}/.openclaw"
mkdir -p "${CONFIG_DIR}/extensions"
mkdir -p "${CONFIG_DIR}/logs"

# Register plugin via CLI (creates plugins.installs record + load.paths)
OPENCLAW_HOME="$TEMP_DIR" openclaw plugins install --link "$PLUGIN_SRC" > /dev/null 2>&1

# Overlay teamclaw config onto the generated config
python3 - "$CONFIG_DIR/openclaw.json" "$PLUGIN_SRC" "$PORT" <<'PY'
import json, pathlib, sys

config_path = pathlib.Path(sys.argv[1])
plugin_src = pathlib.Path(sys.argv[2]).resolve()
port = int(sys.argv[3])

config = json.loads(config_path.read_text()) if config_path.exists() else {}

config.setdefault("agents", {}).setdefault("defaults", {}).setdefault("model", {})["primary"] = "zai/glm-5-turbo"
config.setdefault("commands", {})
config["commands"] = {**config.get("commands", {}), "native": "auto", "nativeSkills": "auto", "restart": True, "ownerDisplay": "raw"}
config["gateway"] = {"auth": {"mode": "token", "token": "47989963b032656bbfe24aee1f459531402cbd90a34fc83d"}}
config.setdefault("plugins", {})
config["plugins"]["allow"] = list(set(config["plugins"].get("allow", []) + ["teamclaw"]))
config["plugins"]["entries"] = {
  "teamclaw": {
    "enabled": True,
    "config": {
      "mode": "controller",
      "port": port,
      "teamName": "calc-project",
      "gitEnabled": False,
      "heartbeatIntervalMs": 5000,
      "taskTimeoutMs": 300000,
      "workerProvisioningType": "process",
      "workerProvisioningRoles": ["developer", "qa", "architect"],
      "workerProvisioningMinPerRole": 1,
      "workerProvisioningMaxPerRole": 1,
      "workerProvisioningIdleTtlMs": 300000,
      "workerProvisioningStartupTimeoutMs": 120000
    }
  }
}

config_path.write_text(json.dumps(config, indent=2) + "\n")
PY

echo "  Config:     ${CONFIG_DIR}/openclaw.json"
echo "  Plugin src: ${PLUGIN_SRC}"
echo "  Port:       ${PORT}"
echo ""

# ----------------------------------------------------------
# Step 1: Start controller with process provisioner
# ----------------------------------------------------------
echo -e "${BOLD}[1/6]${NC} Starting controller with process provisioner..."

OPENCLAW_HOME="$TEMP_DIR" \
ZAI_API_KEY="${ZAI_API_KEY}" \
  openclaw gateway --allow-unconfigured --port "$PORT" > "${TEMP_DIR}/gateway.log" 2>&1 &
CONTROLLER_PID=$!

# Wait for teamclaw controller to bind its HTTP server (dynamic port)
log_info "Waiting for controller to bind HTTP port..."
TEAMCLAW_PORT=""
for i in $(seq 1 30); do
  TEAMCLAW_PORT=$(grep 'Controller: HTTP server listening on port' "${TEMP_DIR}/gateway.log" 2>/dev/null | sed 's/.*port \([0-9]*\).*/\1/' | head -1 || true)
  if [ -n "$TEAMCLAW_PORT" ]; then
    break
  fi
  if ! kill -0 "$CONTROLLER_PID" 2>/dev/null; then
    echo -e "${RED}  Controller process exited unexpectedly!${NC}"
    echo -e "${YELLOW}  Logs:${NC}"
    cat "${TEMP_DIR}/gateway.log" 2>/dev/null | tail -30 || true
    exit 1
  fi
  sleep 2
done

if [ -z "$TEAMCLAW_PORT" ]; then
  log_fail "Controller did not bind HTTP port"
  echo -e "${YELLOW}  Last 30 lines of gateway log:${NC}"
  tail -30 "${TEMP_DIR}/gateway.log" 2>/dev/null || true
  exit 1
fi

BASE_URL="http://127.0.0.1:${TEAMCLAW_PORT}"
log_info "TeamClaw controller on port ${TEAMCLAW_PORT}"

if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
  log_pass "Controller is healthy"
else
  log_fail "Controller did not become healthy"
  exit 1
fi

# ----------------------------------------------------------
# Step 2: Wait for dynamic worker processes to register
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[2/6]${NC} Wait for dynamically provisioned workers..."

log_info "Waiting up to 60s for 3 workers to register..."
WORKERS_READY=false
READY_COUNT=0
for i in $(seq 1 30); do
  READY_COUNT=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
all_workers = data.get('workers', [])
required_roles = ['developer', 'qa', 'architect']
count = 0
for r in required_roles:
    role_workers = [w for w in all_workers if w.get('role') == r]
    if role_workers and role_workers[0].get('status') in ('ready', 'idle'):
        count += 1
print(count)
" 2>/dev/null || echo "0")

  if [ "$READY_COUNT" -ge 3 ]; then
    WORKERS_READY=true
    log_pass "All 3 workers registered (${READY_COUNT}/3)"
    break
  fi
  sleep 2
done

if [ "$WORKERS_READY" != true ]; then
  log_fail "Only ${READY_COUNT}/3 workers registered after 60s"
  echo ""
  log_info "Team status dump:"
  curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  (could not fetch)"
fi

# ----------------------------------------------------------
# Step 3: Verify child process topology
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[3/6]${NC} Verify process topology..."

# Controller + child openclaw-gateway processes
GATEWAY_COUNT=$(pgrep -x "openclaw-gateway" | wc -l | tr -d ' ' || echo "0")
OPENCLAW_COUNT=$(pgrep -x "openclaw" | wc -l | tr -d ' ' || echo "0")
TOTAL_PROCS=$((OPENCLAW_COUNT + GATEWAY_COUNT))
if [ "$TOTAL_PROCS" -ge 3 ]; then
  log_pass "Multiple processes detected (openclaw: ${OPENCLAW_COUNT}, openclaw-gateway: ${GATEWAY_COUNT})"
else
  log_fail "Expected >= 3 processes, found ${TOTAL_PROCS} (openclaw: ${OPENCLAW_COUNT}, openclaw-gateway: ${GATEWAY_COUNT})"
fi

# ----------------------------------------------------------
# Step 4: Verify workspace sharing (symlinks)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[4/6]${NC} Verify workspace/extension sharing..."

# ProcessProvisioner creates symlinks for extensions
SYMLINK_COUNT=$(find /tmp -maxdepth 4 -type l -path "*openclaw*extensions*" 2>/dev/null | wc -l | tr -d ' ')
if [ "$SYMLINK_COUNT" -gt 0 ]; then
  log_pass "Extension symlinks found (${SYMLINK_COUNT})"
else
  log_info "No extension symlinks found in /tmp (may use different base dir)"
fi

# ----------------------------------------------------------
# Step 5: Submit a task
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[5/6]${NC} Submit test task..."

TASK_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "S2 smoke test",
    "description": "Reply with exactly: S2_TEST_OK",
    "assignedRole": "developer"
  }' 2>/dev/null || echo "{}")

TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "" ]; then
  log_pass "Task created: ${TASK_ID}"
else
  log_fail "Failed to create task"
fi

# ----------------------------------------------------------
# Step 6: Run full API test suite
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[6/7]${NC} Run full API test suite..."

if [ -f "${SCRIPT_DIR}/test-api.sh" ]; then
  bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "distributed"
else
  log_skip "test-api.sh not found, skipping full suite"
fi

# ----------------------------------------------------------
# Step 7: Run E2E delivery test (LLM-powered)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[7/7]${NC} Run E2E delivery test..."

REQUIREMENT_FILE="${SCRIPT_DIR}/requirements/s2-logistics-wms.md"
if [ -f "${SCRIPT_DIR}/test-e2e-delivery.sh" ] && [ -f "$REQUIREMENT_FILE" ]; then
  bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "$REQUIREMENT_FILE" "distributed" 900
else
  log_skip "test-e2e-delivery.sh or requirement file not found, skipping E2E delivery test"
fi

# ----------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}S2: Local Dynamic Provision test complete.${NC}"
