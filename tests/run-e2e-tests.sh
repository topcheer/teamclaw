#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# TeamClaw 6-Topology E2E Delivery Test Runner
# ============================================================
# Starts each topology environment inline (not delegating to
# the smoke-test scripts), waits for real workers to register,
# then submits a real software requirement via
# controller/intake and waits for LLM-powered execution.
#
# On any teamclaw-logic failure the runner records the bug,
# continues to the next topology, then prints a consolidated
# report at the end.
#
# Usage:
#   bash tests/run-e2e-tests.sh [--skip-build] [s1|s2|s3|s4|s5|s6|all]
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SRC="${PROJECT_ROOT}/src"

if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a; source "${SCRIPT_DIR}/.env"; set +a
fi
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo -e "\033[0;31mERROR: ZAI_API_KEY not set. Add to tests/.env\033[0m"
  exit 1
fi

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; }
log_info() { echo -e "  ${CYAN}INFO${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }

# ── Argument parsing ─────────────────────────────────
SKIP_BUILD=false
SCENARIOS=""
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    s1|s2|s3|s4|s5|s6) SCENARIOS="$SCENARIOS $arg" ;;
    all) SCENARIOS="s1 s2 s3 s4 s5 s6" ;;
  esac
done
[ -z "$SCENARIOS" ] && SCENARIOS="s1 s2 s3 s4 s5 s6"

# ── Requirement mapping ────────────────────────────
declare -A REQ_FILES=(
  [s1]="${SCRIPT_DIR}/requirements/s1-url-shortener.md"
  [s2]="${SCRIPT_DIR}/requirements/s2-todo-api.md"
  [s3]="${SCRIPT_DIR}/requirements/s3-markdown-blog.md"
  [s4]="${SCRIPT_DIR}/requirements/s4-chat-api.md"
  [s5]="${SCRIPT_DIR}/requirements/s5-weather-api.md"
  [s6]="${SCRIPT_DIR}/requirements/s6-inventory-cli.md"
)
declare -A TOPOLOGY_NAMES=(
  [s1]="S1: Local Single Process"
  [s2]="S2: Local Dynamic Process"
  [s3]="S3: Docker Distributed"
  [s4]="S4: Docker Dynamic Provision"
  [s5]="S5: K8s Single Pod"
  [s6]="S6: K8s Dynamic Provision"
)
declare -A TOPOLOGY_TYPE=(
  [s1]="single-instance"
  [s2]="distributed"
  [s3]="distributed"
  [s4]="distributed"
  [s5]="single-instance"
  [s6]="distributed"
)

RESULTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-e2e.XXXXXX")"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
REPORT_FILE="${RESULTS_DIR}/report.txt"

E2E_SCRIPT="${SCRIPT_DIR}/test-e2e-delivery.sh"

# ── Docker host detection ────────────────────────────
# For Docker-based topologies (S3/S4), detect whether the Docker
# daemon is local (unix socket / OrbStack) or remote (TCP/SSH).
# Remote Docker daemons need the Docker host IP instead of localhost.
DOCKER_HOST_IP="localhost"
detect_docker_host() {
  local ctx
  ctx=$(docker context show 2>/dev/null || true)
  [ -z "$ctx" ] && return 0  # can't detect, assume local

  local endpoint
  endpoint=$(docker context inspect "$ctx" --format '{{.DockerEndpoint}}' 2>/dev/null || true)
  [ -z "$endpoint" ] && return 0

  # Unix socket or OrbStack = local, localhost works fine
  if echo "$endpoint" | grep -q 'unix://\|/\.orbstack/'; then
    DOCKER_HOST_IP="localhost"
  # TCP endpoint = potentially remote, extract host
  elif echo "$endpoint" | grep -qE 'tcp://|ssh://'; then
    local host
    host=$(echo "$endpoint" | sed -E 's#^(tcp|ssh)://([^:]+).*#\2#')
    # Verify it's not a loopback address
    if echo "$host" | grep -qE '^(127\.|localhost|::1)'; then
      DOCKER_HOST_IP="localhost"
    else
      DOCKER_HOST_IP="$host"
      log_info "Docker context '${ctx}' is remote (${host}) — using DOCKER_HOST_IP=${host}"
    fi
  fi
}
detect_docker_host

# Global cleanup
E2E_PIDS=()
E2E_TEMP_DIRS=()
trap cleanup EXIT

cleanup() {
  # Kill any remaining background processes
  for pid in "${E2E_PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true

  # Kill any orphaned openclaw processes spawned by S2
  pkill -9 -f "openclaw-gateway" 2>/dev/null || true

  # Kill S3/S4 docker containers
  docker compose -f "${SCRIPT_DIR}/docker-compose.test.yml" down --remove-orphans 2>/dev/null &
  docker compose -f "${SCRIPT_DIR}/docker-compose.s4.test.yml" down --remove-orphans 2>/dev/null &
  wait 2>/dev/null || true

  # Clean temp dirs
  for d in "${E2E_TEMP_DIRS[@]:-}"; do
    rm -rf "$d" 2>/dev/null || true
  done
}

# ── Helpers ──────────────────────────────────────────

wait_for_workers() {
  local base_url="$1"
  local min_workers="$2"
  local timeout="$3"
  local elapsed=0
  local interval=3

  while [ "$elapsed" -lt "$timeout" ]; do
    local wc=$(curl -sf --max-time 5 "${base_url}/api/v1/team/status" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)
idle = sum(1 for w in d.get('workers',[]) if w.get('status') == 'idle')
print(idle)
" 2>/dev/null || echo "0")

    if [ "$wc" -ge "$min_workers" ]; then
      return 0
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))

    if [ $((elapsed % 15)) -eq 0 ] && [ "$elapsed" -gt 0 ]; then
      log_info "Waiting for workers... (${wc}/${min_workers} ready, ${elapsed}s)"
    fi
  done

  log_fail "Only ${wc}/${min_workers} workers ready after ${timeout}s"
  return 1
}

wait_for_healthy() {
  local base_url="$1"
  local timeout="$2"
  local elapsed=0
  local interval=2

  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf --max-time 3 "${base_url}/api/v1/health" > /dev/null 2>&1; then
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 1
}

# ── Topology launchers ───────────────────────────────

launch_s1() {
  local temp_dir
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-e2e-s1.XXXXXX")"
  E2E_TEMP_DIRS+=("$temp_dir")

  local config_dir="${temp_dir}/.openclaw"
  mkdir -p "${config_dir}/extensions" "${config_dir}/logs"

  OPENCLAW_HOME="$temp_dir" openclaw plugins install --link "$PLUGIN_SRC" > /dev/null 2>&1

  # Find a free port
  local gw_port
  gw_port=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")

  python3 - "$config_dir/openclaw.json" "$PLUGIN_SRC" "$gw_port" <<'PY'
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
      "teamName": "e2e-test",
      "gitEnabled": False,
      "heartbeatIntervalMs": 5000,
      "taskTimeoutMs": 600000,
      "localRoles": ["developer", "qa", "architect"]
    }
  }
}
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY

  OPENCLAW_HOME="$temp_dir" ZAI_API_KEY="${ZAI_API_KEY}" \
    openclaw gateway --allow-unconfigured --port "$gw_port" \
    > "${temp_dir}/gateway.log" 2>&1 &
  E2E_PIDS+=($!)

  # Extract dynamic port
  local base_url=""
  for i in $(seq 1 60); do
    base_url=$(grep 'listening on port' "${temp_dir}/gateway.log" 2>/dev/null | sed 's/.*port \([0-9]*\).*/\1/' | head -1)
    [ -n "$base_url" ] && break
    sleep 2
    if ! kill -0 "${E2E_PIDS[-1]}" 2>/dev/null; then
      log_fail "Controller process exited unexpectedly"
      return 1
    fi
  done

  if [ -z "$base_url" ]; then
    log_fail "Controller did not bind port"
    return 1
  fi

  echo "$base_url"
  return 0
}

launch_s2() {
  local temp_dir
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-e2e-s2.XXXXXX")"
  E2E_TEMP_DIRS+=("$temp_dir")

  local config_dir="${temp_dir}/.openclaw"
  mkdir -p "${config_dir}/extensions" "${config_dir}/logs"

  OPENCLAW_HOME="$temp_dir" openclaw plugins install --link "$PLUGIN_SRC" > /dev/null 2>&1

  # Find a free port
  local gw_port
  gw_port=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); p=s.getsockname()[1]; s.close(); print(p)")

  python3 - "$config_dir/openclaw.json" "$PLUGIN_SRC" "$gw_port" <<'PY'
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
      "teamName": "e2e-test",
      "gitEnabled": False,
      "heartbeatIntervalMs": 5000,
      "taskTimeoutMs": 600000,
      "workerProvisioningType": "process",
      "workerProvisioningRoles": ["developer", "qa", "architect"],
      "workerProvisioningMinPerRole": 1,
      "workerProvisioningMaxPerRole": 1,
      "workerProvisioningIdleTtlMs": 600000,
      "workerProvisioningStartupTimeoutMs": 120000,
      "workerProvisioningPassEnv": ["ZAI_API_KEY"]
    }
  }
}
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY

  OPENCLAW_HOME="$temp_dir" ZAI_API_KEY="${ZAI_API_KEY}" \
    openclaw gateway --allow-unconfigured --port "$gw_port" \
    > "${temp_dir}/gateway.log" 2>&1 &
  E2E_PIDS+=($!)

  local base_url=""
  for i in $(seq 1 60); do
    base_url=$(grep 'listening on port' "${temp_dir}/gateway.log" 2>/dev/null | sed 's/.*port \([0-9]*\).*/\1/' | head -1)
    [ -n "$base_url" ] && break
    sleep 2
    if ! kill -0 "${E2E_PIDS[-1]}" 2>/dev/null; then
      log_fail "Controller process exited"
      return 1
    fi
  done

  if [ -z "$base_url" ]; then
    log_fail "Controller did not bind port"
    return 1
  fi

  echo "$base_url"
  return 0
}

launch_s3() {
  local temp_dir
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-e2e-s3.XXXXXX")"
  E2E_TEMP_DIRS+=("$temp_dir")

  local build_flag=""
  if [ "$SKIP_BUILD" = true ]; then build_flag="--skip-build"; fi

  # run-tests.sh handles its own config preparation via prepare_distributed_configs()
  # Just need to pass TEST_ENV_FILE and ZAI_API_KEY
  TEST_ENV_FILE="${SCRIPT_DIR}/.env" \
    ZAI_API_KEY="${ZAI_API_KEY}" \
    bash "${SCRIPT_DIR}/run-tests.sh" $build_flag \
    > "${temp_dir}/s3.log" 2>&1 &
  E2E_PIDS+=($!)

  # Wait for Docker containers to start + controller to be healthy
  local base_url="http://${DOCKER_HOST_IP}:9527"
  for i in $(seq 1 90); do
    if curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  if ! curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
    log_fail "Controller not healthy"
    return 1
  fi

  echo "$base_url"
  return 0
}

launch_s4() {
  local temp_dir
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-e2e-s4.XXXXXX")"
  E2E_TEMP_DIRS+=("$temp_dir")

  local build_flag=""
  if [ "$SKIP_BUILD" = true ]; then build_flag="--skip-build"; fi

  ZAI_API_KEY="${ZAI_API_KEY}" \
    bash "${SCRIPT_DIR}/test-docker-dynamic.sh" $build_flag \
    > "${temp_dir}/s4.log" 2>&1 &
  E2E_PIDS+=($!)

  local base_url="http://${DOCKER_HOST_IP}:9527"
  for i in $(seq 1 90); do
    if curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  if ! curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
    log_fail "Controller not healthy"
    return 1
  fi

  echo "$base_url"
  return 0
}

launch_s5() {
  local base_url="http://localhost:9527"

  bash "${SCRIPT_DIR}/test-k8s-single.sh" \
    > "${RESULTS_DIR}/s5.log" 2>&1 &
  E2E_PIDS+=($!)

  for i in $(seq 1 120); do
    if curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  if ! curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
    log_fail "Controller not healthy"
    return 1
  fi

  echo "$base_url"
  return 0
}

launch_s6() {
  local base_url="http://localhost:9528"

  bash "${SCRIPT_DIR}/test-k8s-dynamic.sh" \
    > "${RESULTS_DIR}/s6.log" 2>&1 &
  E2E_PIDS+=($!)

  for i in $(seq 1 150); do
    if curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  if ! curl -sf --max-time 5 "${base_url}/api/v1/health" > /dev/null 2>&1; then
    log_fail "Controller not healthy"
    return 1
  fi

  echo "$base_url"
  return 0
}

# ── Main header ─────────────────────────────────────

echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║  TeamClaw 6-Topology E2E Delivery Test Runner    ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Scenarios:  ${SCENARIOS}"
echo "  Timestamp:  ${TIMESTAMP}"
echo "  Results:    ${RESULTS_DIR}"
echo "  Skip build: ${SKIP_BUILD}"
echo ""

{
  echo "# TeamClaw E2E Delivery Test Report"
  echo "# Timestamp: ${TIMESTAMP}"
  echo "# Scenarios: ${SCENARIOS}"
  echo ""
} > "$REPORT_FILE"

PASS_COUNT=0
FAIL_COUNT=0

# ── Run each topology ────────────────────────────────

for scenario in $SCENARIOS; do
  name="${TOPOLOGY_NAMES[$scenario]}"
  req_file="${REQ_FILES[$scenario]}"
  topology="${TOPOLOGY_TYPE[$scenario]}"
  setup_log="${RESULTS_DIR}/${scenario}-setup.log"

  echo -e "──────────────────────────────────────────────"
  echo -e "${BOLD}${CYAN}[${scenario^^}]${NC} ${name}"
  echo "  Requirement: $(basename "$req_file")"
  echo "  Topology:   ${topology}"

  {
    echo "## ${name}"
    echo "- Requirement: $(basename "$req_file")"
    echo "- Topology: ${topology}"
  } >> "$REPORT_FILE"

  # ── Launch ──
  echo -e "  Launching environment..."
  base_url=""

  case "$scenario" in
    s1) base_url=$(launch_s1 2>"$setup_log") || { echo "  (launch failed)"; cat "$setup_log"; echo "**FAIL**: launch failed" >> "$REPORT_FILE"; echo "" >> "$REPORT_FILE"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
    s2) base_url=$(launch_s2 2>"$setup_log") || { echo "  (launch failed)"; cat "$setup_log"; echo "**FAIL**: launch failed" >> "$REPORT_FILE"; echo "" >> "$REPORT_FILE"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
    s3) base_url=$(launch_s3 2>"$setup_log") || { echo "  (launch failed)"; cat "$setup_log"; echo "**FAIL**: launch failed" >> "$REPORT_FILE"; echo "" >> "$REPORT_FILE"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
    s4) base_url=$(launch_s4 2>"$setup_log") || { echo "  (launch failed)"; cat "$setup_log"; echo "**FAIL**: launch failed" >> "$REPORT_FILE"; echo "" >> "$REPORT_FILE"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
    s5) base_url=$(launch_s5 2>"$setup_log") || { echo "  (launch failed)"; cat "$setup_log"; echo "**FAIL**: launch failed" >> "$REPORT_FILE"; echo "" >> "$REPORT_FILE"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
    s6) base_url=$(launch_s6 2>"$setup_log") || { echo "  (launch failed)"; cat "$setup_log"; echo "**FAIL**: launch failed" >> "$REPORT_FILE"; echo "" >> "$REPORT_FILE"; FAIL_COUNT=$((FAIL_COUNT + 1)); continue; } ;;
  esac

  # S1/S2 return bare port numbers; S3-S6 return full URLs
  case "$scenario" in
    s1|s2) base_url="http://127.0.0.1:${base_url}" ;;
  esac
  log_pass "Environment ready at ${base_url}"

  # ── Wait for workers ──
  echo -e "  Waiting for workers to register..."
  if ! wait_for_workers "$base_url" 3 120; then
    log_fail "Workers not ready — skipping E2E test"
    echo "**FAIL**: Workers not ready" >> "$REPORT_FILE"

    echo "### Setup log (last 30 lines):" >> "$REPORT_FILE"
    echo '```' >> "$REPORT_FILE"
    tail -30 "${setup_log:-/dev/null}" >> "$REPORT_FILE" 2>/dev/null || true
    echo '```' >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    continue
  fi

  # ── Run E2E delivery test ──
  start_time=$(date +%s)

  e2e_log="${RESULTS_DIR}/${scenario}-e2e.log"
  bash "$E2E_SCRIPT" "$base_url" "$req_file" "$topology" 600 \
    > "$e2e_log" 2>&1
  e2e_exit=$?

  end_time=$(date +%s)
  duration=$((end_time - start_time))

  # ── Report ──
  if [ "$e2e_exit" -eq 0 ]; then
    echo -e "  ${GREEN}PASS${NC} (${duration}s)"
    echo "**PASS** (${duration}s)" >> "$REPORT_FILE"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "  ${RED}FAIL${NC} (exit code ${e2e_exit}, ${duration}s)"
    echo "**FAIL** (exit code ${e2e_exit}, ${duration}s)" >> "$REPORT_FILE"

    echo "### E2E log (last 50 lines):" >> "$REPORT_FILE"
    echo '```' >> "$REPORT_FILE"
    tail -50 "$e2e_log" >> "$REPORT_FILE" 2>/dev/null || true
    echo '```' >> "$REPORT_FILE"
  fi

  echo "### Setup log (last 30 lines):" >> "$REPORT_FILE"
  echo '```' >> "$REPORT_FILE"
  tail -30 "${setup_log:-/dev/null}" >> "$REPORT_FILE" 2>/dev/null || true
  echo '```' >> "$REPORT_FILE"
  echo "" >> "$REPORT_FILE"
done

# ── Final report ──────────────────────────────────

echo ""
echo -e "${BOLD}${CYAN}════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Final Report${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════${NC}"
echo "  Total:  $((PASS_COUNT + FAIL_COUNT))"
echo -e "  ${GREEN}Passed: ${PASS_COUNT}${NC}"
echo -e "  ${RED}Failed: ${FAIL_COUNT}${NC}"
echo "  Report:  ${REPORT_FILE}"
echo ""

{
  echo "## Summary"
  echo "- **Total**: $((PASS_COUNT + FAIL_COUNT))"
  echo "- **Passed**: ${PASS_COUNT}"
  echo "- **Failed**: ${FAIL_COUNT}"
  echo ""
} >> "$REPORT_FILE"

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${RED}${BOLD}RESULT: SOME TESTS FAILED${NC}"
  exit 1
else
  echo -e "${GREEN}${BOLD}RESULT: ALL TESTS PASSED${NC}"
  exit 0
fi
