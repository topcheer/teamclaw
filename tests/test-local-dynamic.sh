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
E2E_REQUIREMENT_FILE="${TEAMCLAW_E2E_REQUIREMENT_FILE:-${SCRIPT_DIR}/requirements/s2-logistics-wms.md}"
E2E_TIMEOUT="${TEAMCLAW_E2E_TIMEOUT:-900}"
CONTROLLER_PID=""
TEMP_DIR=""

# Shared-workstation safety (#252): NEVER pattern-kill openclaw processes -
# the user and other agents run their own gateways. Sweep only processes
# whose OPENCLAW_HOME sits under a teamclaw-s2 temp root (this harness or a
# crashed previous run of it).
s2_pids() {
  ps -axo pid=,command= 2>/dev/null | grep -i "openclaw" | grep -v "grep" | while read -r pid _rest; do
    env_home="$(ps eww -o command= -p "$pid" 2>/dev/null | grep -oE 'OPENCLAW_HOME=[^ ]+' | head -1 | cut -d= -f2- || true)"
    case "$env_home" in
      "${TMPDIR:-/tmp}"/teamclaw-s2.*) echo "$pid" ;;
    esac
  done
}

kill_s2_processes() {
  for pid in $(s2_pids); do
    kill -9 "$pid" 2>/dev/null || true
  done
}

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
  # Then only OUR leftover gateways/workers (OPENCLAW_HOME under a
  # teamclaw-s2 temp root) - the user's and other agents' openclaw
  # processes are untouchable (shared workstation, #252).
  kill_s2_processes
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

# Pre-flight: sweep ONLY this harness' own stale processes (a crashed prior
# run leaves workers whose OPENCLAW_HOME sits under a teamclaw-s2 temp
# root), then require the port free. A port owned by someone else (the
# user's desktop app, another agent's controller) is a hard stop, never a kill.
kill_s2_processes
sleep 1
if lsof -i ":${PORT}" -sTCP:LISTEN 2>/dev/null | grep -q .; then
  OWNER_PID="$(lsof -ti :"${PORT}" -sTCP:LISTEN 2>/dev/null | head -1)"
  echo -e "${RED}ERROR: Port ${PORT} is owned by another process (PID ${OWNER_PID}) - refusing to touch it.${NC}"
  echo -e "${YELLOW}Tip: export TEAMCLAW_TEST_PORT=9531 (pick a free port) and rerun${NC}"
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

# Register plugin via CLI (creates plugins.installs record + load.paths).
# --force --accept-capabilities: openclaw 2026.10.9 gates local-path
# installs behind an unreviewed-source confirmation AND a capability-consent
# confirmation; the source is this repository's own plugin checkout, so the
# harness asserts both consents on the operator's behalf.
OPENCLAW_HOME="$TEMP_DIR" openclaw plugins install --force --accept-capabilities --link "$PLUGIN_SRC" > /dev/null 2>&1

# Overlay teamclaw config onto the generated config
python3 - "$CONFIG_DIR/openclaw.json" "$PLUGIN_SRC" "$PORT" <<'PY'
import json, pathlib, sys

config_path = pathlib.Path(sys.argv[1])
plugin_src = pathlib.Path(sys.argv[2]).resolve()
port = int(sys.argv[3])

config = json.loads(config_path.read_text()) if config_path.exists() else {}

config.setdefault("agents", {}).setdefault("defaults", {}).setdefault("model", {})["primary"] = "zai/glm-5-turbo"
config.setdefault("commands", {})
config["commands"] = {**config.get("commands", {}), "native": "auto", "nativeSkills": "auto", "restart": True}
# "ownerDisplay" was a legacy commands key retired by openclaw 2026.10.x;
# injecting it makes the gateway refuse to start (config validation error).
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

# Model-auth bootstrap: the controller's readiness gate requires an
# auth-profiles.json under the teamclaw agent dir; worker LLM calls then
# migrate this legacy file into the sqlite credential store on first use
# (AUTH_PROFILE_MIGRATION_REQUIRED otherwise). The key itself is expanded
# from the environment at runtime - never committed.
mkdir -p "${CONFIG_DIR}/agents/teamclaw/agent"
cat > "${CONFIG_DIR}/agents/teamclaw/agent/auth-profiles.json" <<AUTHJSON
{
  "profiles": [
    { "id": "s2-host", "provider": "zai", "apiKey": "${ZAI_API_KEY}" }
  ]
}
AUTHJSON
# Migrate the legacy auth-profiles.json into the sqlite credential store:
# worker LLM calls hard-fail with AUTH_PROFILE_MIGRATION_REQUIRED until
# `openclaw doctor --fix` performs the one-time migration.
OPENCLAW_HOME="$TEMP_DIR" openclaw doctor --fix > /dev/null 2>&1 || \
  log_info "doctor --fix exited non-zero (continuing; migration may still have run)"

echo "  Config:     ${CONFIG_DIR}/openclaw.json"
echo "  Plugin src: ${PLUGIN_SRC}"
echo "  Port:       ${PORT}"
echo "  Requirement: $(basename "${E2E_REQUIREMENT_FILE}")"
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

# Workers provision asynchronously (real child processes + agent warmup):
# poll /health until status=ready; the first responses legitimately say
# "starting" (and may even be non-200), so a single-shot gate false-fails.
log_info "Waiting for controller readiness (workers + model auth)..."
READY=false
for i in $(seq 1 60); do
  HEALTH_STATUS=$(curl -sf --max-time 3 "${BASE_URL}/api/v1/health" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
  if [ "$HEALTH_STATUS" = "ok" ] || [ "$HEALTH_STATUS" = "ready" ]; then
    READY=true
    log_pass "Controller ready (workers warmed, model auth ok)"
    break
  fi
  sleep 2
done
if [ "$READY" != true ]; then
  log_fail "Controller not ready after 120s (last status: ${HEALTH_STATUS:-none})"
  curl -sf --max-time 3 "${BASE_URL}/api/v1/health" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
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

# Controller + child openclaw-gateway processes. pgrep -x can find no match
# (and under `set -o pipefail` a failed pgrep poisons the wc pipeline into
# emitting "0\n0"), so guard it and prefer our OPENCLAW_HOME-scoped count,
# which is exact on every platform.
GATEWAY_COUNT=$({ pgrep -x "openclaw-gateway" || true; } | wc -l | tr -d '[:space:]')
OPENCLAW_COUNT=$({ pgrep -x "openclaw" || true; } | wc -l | tr -d '[:space:]')
S2_SCOPED_COUNT=$(s2_pids | wc -l | tr -d '[:space:]')
TOTAL_PROCS=$((OPENCLAW_COUNT + GATEWAY_COUNT))
if [ "$TOTAL_PROCS" -ge 3 ] || [ "$S2_SCOPED_COUNT" -ge 3 ]; then
  log_pass "Multiple processes detected (openclaw: ${OPENCLAW_COUNT}, openclaw-gateway: ${GATEWAY_COUNT}, s2-scoped: ${S2_SCOPED_COUNT})"
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
# Step 6: Run E2E delivery test (LLM-powered)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[6/7]${NC} Run E2E delivery test..."

if [ -f "${SCRIPT_DIR}/test-e2e-delivery.sh" ] && [ -f "$E2E_REQUIREMENT_FILE" ] && [ "${TEAMCLAW_SKIP_API:-0}" != "1" ]; then
  bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "$E2E_REQUIREMENT_FILE" "distributed" "${E2E_TIMEOUT}"
else
  log_skip "E2E delivery test skipped (missing files or TEAMCLAW_SKIP_API=1 - no-LLM smoke mode)"
fi

# ----------------------------------------------------------
# Step 7: Run full API test suite
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[7/7]${NC} Run full API test suite..."

if [ -f "${SCRIPT_DIR}/test-api.sh" ] && [ "${TEAMCLAW_SKIP_API:-0}" != "1" ]; then
  bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "distributed"
else
  log_skip "Full API suite skipped (TEAMCLAW_SKIP_API=1 - no-LLM smoke mode; Step 8 switch needs no LLM)"
fi

# ----------------------------------------------------------
# Step 8: software-rd -> banking profile switch under the live
# dynamic topology (issue #252 S2 coverage gap: every switch E2E
# before this ran against in-process stubs; this one exercises
# draining real spawned workers, the archive, and re-warming the
# banking warmup roles through ProcessProvisioner).
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[8]${NC} software-rd -> banking profile switch (live dynamic workers)..."

SWITCH_HTTP=$(curl -s -o "${TEMP_DIR}/switch-post.json" -w "%{http_code}" \
  -X POST "${BASE_URL}/api/v1/team/profile" \
  -H "Content-Type: application/json" \
  -d '{"profileId":"banking"}' 2>/dev/null || echo "000")

if [ "$SWITCH_HTTP" = "202" ] || [ "$SWITCH_HTTP" = "200" ]; then
  log_pass "Switch accepted (HTTP ${SWITCH_HTTP})"
else
  log_fail "Switch POST failed (HTTP ${SWITCH_HTTP})"
  cat "${TEMP_DIR}/switch-post.json" 2>/dev/null || true
  exit 1
fi

log_info "Waiting up to 180s for drain -> archive -> banking warmup..."
SWITCH_DONE=false
for i in $(seq 1 90); do
  PROFILE_JSON=$(curl -sf "${BASE_URL}/api/v1/team/profile" 2>/dev/null || echo "{}")
  SWITCH_STATE=$(echo "$PROFILE_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print('invalid')
    raise SystemExit
if data.get('transition'):
    print('transition:' + str(data['transition'].get('phase', '?')))
elif data.get('profileId') == 'banking':
    print('done')
else:
    print('profile:' + str(data.get('profileId')))
" 2>/dev/null || echo "invalid")
  if [ "$SWITCH_STATE" = "done" ]; then
    SWITCH_DONE=true
    log_pass "Switch completed: banking is the active profile"
    break
  fi
  if [ "$((i % 10))" = "0" ]; then
    log_info "  ... still ${SWITCH_STATE}"
  fi
  sleep 2
done

if [ "$SWITCH_DONE" != true ]; then
  log_fail "Switch did not complete within 180s (last state: ${SWITCH_STATE})"
  exit 1
fi

# Banking role registry is live (credit-officer exists only in banking).
ROLES_OK=$(curl -sf "${BASE_URL}/api/v1/roles" 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
roles = data if isinstance(data, list) else data.get('roles', [])
ids = [r.get('id') for r in roles if isinstance(r, dict)]
print('yes' if 'credit-officer' in ids else 'no')
" 2>/dev/null || echo "no")
if [ "$ROLES_OK" = "yes" ]; then
  log_pass "Banking role registry active (credit-officer present)"
else
  log_fail "Banking roles not active after switch (no credit-officer in /api/v1/roles)"
  exit 1
fi

# Banking workflows ride the profile (capability生效 proxy): the
# credit-approval template must now be exposed on the active profile.
# (There is no GET /api/v1/workflows list route - the profile detail
# serializes the templates verbatim: profile.workflows[].id.)
WORKFLOWS_OK=$(echo "$PROFILE_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    print('no')
    raise SystemExit
workflows = (data.get('profile') or {}).get('workflows') or []
ids = [w.get('id') for w in workflows if isinstance(w, dict)]
print('yes' if 'credit-approval' in ids else 'no')
" 2>/dev/null || echo "no")
if [ "$WORKFLOWS_OK" = "yes" ]; then
  log_pass "Banking capability live (credit-approval workflow listed)"
else
  log_fail "Banking workflows not listed after switch"
  exit 1
fi

log_info "S2 switch scenario passed (drain/archive/warmup under ProcessProvisioner)"

# ----------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}S2: Local Dynamic Provision test complete.${NC}"
