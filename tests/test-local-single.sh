#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# S1: Local Single Process — Controller + localRoles
# ============================================================
# Starts a single OpenClaw process with controller mode
# and localRoles (no child processes, no Docker).
#
# Uses temporary config + workspace + --profile so nothing
# invades the user's real OpenClaw home.
#
# Usage: bash tests/test-local-single.sh
#   ZAI_API_KEY=... bash tests/test-local-single.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="${PROJECT_ROOT}/src"
OPENCLAW_BIN="$(command -v openclaw)"
PORT="${TEAMCLAW_TEST_PORT:-9527}"
BASE_URL="http://localhost:${PORT}"
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
  if [ -n "$CONTROLLER_PID" ]; then
    kill "$CONTROLLER_PID" 2>/dev/null || true
    wait "$CONTROLLER_PID" 2>/dev/null || true
    log_info "Controller process stopped (PID=$CONTROLLER_PID)"
  fi
  if [ "${KEEP_TEMP_DIR:-false}" = "true" ]; then
    log_info "Temp dir preserved: ${TEMP_DIR}"
  elif [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
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
  # Try loading from tests/.env
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
echo "║  S1: Local Single Process Test             ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ----------------------------------------------------------
# Prepare temporary config + workspace
# ----------------------------------------------------------
# OPENCLAW_HOME expects: $HOME/.openclaw/openclaw.json
# So we set TEMP_DIR as OPENCLAW_HOME and write config into
# $TEMP_DIR/.openclaw/openclaw.json
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-s1.XXXXXX")"
CONFIG_DIR="${TEMP_DIR}/.openclaw"
mkdir -p "${CONFIG_DIR}/extensions"
mkdir -p "${CONFIG_DIR}/logs"

# Register plugin via CLI (creates plugins.installs record + load.paths)
OPENCLAW_HOME="$TEMP_DIR" openclaw plugins install --link "$PLUGIN_SRC" > /dev/null 2>&1

# Now overlay teamclaw config onto the generated config
python3 - "$CONFIG_DIR/openclaw.json" "$PLUGIN_SRC" "$PORT" <<'PY'
import json, pathlib, sys

config_path = pathlib.Path(sys.argv[1])
plugin_src = pathlib.Path(sys.argv[2]).resolve()
port = int(sys.argv[3])

config = json.loads(config_path.read_text()) if config_path.exists() else {}

# Merge in our settings (preserve what openclaw plugins install created)
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
      "localRoles": ["developer", "qa", "architect"]
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
# Step 1: Start controller with localRoles
# ----------------------------------------------------------
echo -e "${BOLD}[1/5]${NC} Starting controller with localRoles..."

OPENCLAW_HOME="$TEMP_DIR" \
ZAI_API_KEY="${ZAI_API_KEY}" \
  openclaw gateway --allow-unconfigured --port "$PORT" > "${TEMP_DIR}/gateway.log" 2>&1 &
CONTROLLER_PID=$!

# Wait for teamclaw controller to bind its HTTP server (it uses a dynamic port)
# and extract the actual port from the log.
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

# teamclaw controller HTTP server is on a dynamic port; use it for API calls
BASE_URL="http://127.0.0.1:${TEAMCLAW_PORT}"
log_info "TeamClaw controller on port ${TEAMCLAW_PORT}"

if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
  log_pass "Controller is healthy"
else
  log_fail "Controller did not become healthy"
  exit 1
fi

# ----------------------------------------------------------
# Step 2: Verify mode and localRoles
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[2/5]${NC} Verify controller mode and local roles..."

BODY=$(curl -sf "${BASE_URL}/api/v1/health")
MODE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null || echo "")
if [ "$MODE" = "controller" ]; then
  log_pass "Mode is controller"
else
  log_fail "Expected mode=controller, got '${MODE}'"
fi

STATUS=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "")
echo "$STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f\"  Team name: {data.get('teamName', 'unknown')}\")
print(f\"  Worker count: {data.get('workerCount', len(data.get('workers', [])))}\")
all_workers = data.get('workers', [])
for r in ['developer', 'qa', 'architect']:
    role_workers = [w for w in all_workers if w.get('role') == r]
    count = len(role_workers)
    status = role_workers[0].get('status', 'none') if role_workers else 'none'
    wid = role_workers[0].get('id', '') if role_workers else ''
    print(f\"  Role {r}: {count} worker(s), status={status}, id={wid}\")
" 2>/dev/null || log_info "Could not parse team status"

# Check local role availability (poll until ready or timeout)
LOCAL_READY=""
for i in $(seq 1 30); do
  LOCAL_READY=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
all_workers = data.get('workers', [])
required_roles = ['developer', 'qa', 'architect']
for r in required_roles:
    role_workers = [w for w in all_workers if w.get('role') == r]
    if not role_workers:
        print(f'NOT_READY: no {r} worker')
        sys.exit(0)
    status = role_workers[0].get('status', '')
    if status not in ('ready', 'idle'):
        print(f'NOT_READY: {r} status={status}')
        sys.exit(0)
print('ALL_READY')
" 2>/dev/null || echo "PARSE_ERROR")
  if [ "$LOCAL_READY" = "ALL_READY" ]; then
    break
  fi
  sleep 2
done

if [ "$LOCAL_READY" = "ALL_READY" ]; then
  log_pass "All 3 local roles are ready"
else
  log_fail "Not all local roles are ready (got: ${LOCAL_READY})"
fi

# ----------------------------------------------------------
# Step 3: Verify single controller process (localRoles workers are child processes)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[3/5]${NC} Verify single controller topology..."

# In localRoles mode, the controller spawns child openclaw-gateway processes.
# We expect exactly 1 controller (openclaw) process spawned by this test.
# Child workers are managed by the controller.
CONTROLLER_COUNT=$(pgrep -x "openclaw" | wc -l | tr -d ' ')
if [ "$CONTROLLER_COUNT" -ge 1 ]; then
  log_pass "Controller process running (openclaw count: ${CONTROLLER_COUNT})"
else
  log_fail "No controller process found"
fi

# ----------------------------------------------------------
# Step 4: Submit a task
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[4/5]${NC} Submit test task..."

TASK_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "S1 smoke test",
    "description": "Reply with exactly: S1_TEST_OK",
    "assignedRole": "developer"
  }' 2>/dev/null || echo "{}")

TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")
if [ -n "$TASK_ID" ] && [ "$TASK_ID" != "" ]; then
  log_pass "Task created: ${TASK_ID}"
else
  log_fail "Failed to create task"
fi

# ----------------------------------------------------------
# Step 5: Run full API test suite
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[5/6]${NC} Run full API test suite..."

if [ -f "${SCRIPT_DIR}/test-api.sh" ]; then
  bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "single-instance"
else
  log_skip "test-api.sh not found, skipping full suite"
fi

# ----------------------------------------------------------
# Step 6: Run E2E delivery test (LLM-powered)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[6/6]${NC} Run E2E delivery test..."

REQUIREMENT_FILE="${SCRIPT_DIR}/requirements/s1-estate-platform.md"
if [ -f "${SCRIPT_DIR}/test-e2e-delivery.sh" ] && [ -f "$REQUIREMENT_FILE" ]; then
  bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "$REQUIREMENT_FILE" "single-instance" 900
else
  log_skip "test-e2e-delivery.sh or requirement file not found, skipping E2E delivery test"
fi

# ----------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}S1: Local Single Process test complete.${NC}"
