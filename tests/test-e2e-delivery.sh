#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# TeamClaw End-to-End Delivery Test
# ============================================================
# Submits a real software requirement via controller/intake,
# waits for the full LLM-powered workflow (task split → worker
# execution → follow-up), then validates the results.
#
# Usage:
#   bash tests/test-e2e-delivery.sh <base_url> <requirement_file> [topology] [timeout_seconds]
#
# Arguments:
#   base_url          Controller URL (e.g. http://localhost:9527)
#   requirement_file  Path to a .md file containing the requirement
#   topology          Descriptive topology label (default: distributed)
#   timeout_seconds   Max time to wait for full workflow (default: 600)
#
# Exit codes:
#   0  All tasks completed successfully
#   1  Fatal error (env not healthy, intake failed, etc.)
#   2  Tasks created but not all completed within timeout
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE_URL="${1:?Usage: test-e2e-delivery.sh <base_url> <requirement_file> [topology] [timeout]}"
REQUIREMENT_FILE="${2:?Usage: test-e2e-delivery.sh <base_url> <requirement_file> [topology] [timeout]}"
TOPOLOGY="${3:-distributed}"
TIMEOUT="${4:-600}"
INTAKE_TIMEOUT="${INTAKE_TIMEOUT:-$TIMEOUT}"
WORKER_WAIT_TIMEOUT="${WORKER_WAIT_TIMEOUT:-90}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; }
log_info() { echo -e "  ${CYAN}INFO${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }
log_skip() { echo -e "  ${DIM}SKIP${NC} $1"; }

# ----------------------------------------------------------
# Pre-flight
# ----------------------------------------------------------
if [ ! -f "$REQUIREMENT_FILE" ]; then
  echo -e "${RED}ERROR: Requirement file not found: ${REQUIREMENT_FILE}${NC}"
  exit 1
fi

REQUIREMENT=$(cat "$REQUIREMENT_FILE")
E2E_SESSION_KEY="${E2E_SESSION_KEY:-e2e-$(basename "$REQUIREMENT_FILE" .md)-$(date +%s)-$$}"

# Check controller health
HEALTH=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/health" 2>/dev/null || echo "")
if [ -z "$HEALTH" ]; then
  echo -e "${RED}ERROR: Controller not reachable at ${BASE_URL}${NC}"
  exit 1
fi

MODE=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null || echo "")
if [ "$MODE" != "controller" ]; then
  echo -e "${RED}ERROR: Expected mode=controller, got '${MODE}'${NC}"
  exit 1
fi

# Check workers (allow fresh controllers a short warm-up window)
TEAM_STATUS="{}"
WORKER_COUNT=0
WORKER_WAIT_ELAPSED=0
while [ "$WORKER_WAIT_ELAPSED" -le "$WORKER_WAIT_TIMEOUT" ]; do
  TEAM_STATUS=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "{}")
  WORKER_COUNT=$(echo "$TEAM_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('workers',[])))" 2>/dev/null || echo "0")
  if [ "$WORKER_COUNT" -gt 0 ]; then
    break
  fi
  sleep 5
  WORKER_WAIT_ELAPSED=$((WORKER_WAIT_ELAPSED + 5))
done
if [ "$WORKER_COUNT" -eq 0 ]; then
  echo -e "${RED}ERROR: No workers registered after ${WORKER_WAIT_TIMEOUT}s${NC}"
  exit 1
fi

echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║   TeamClaw End-to-End Delivery Test           ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"
echo "  URL:        ${BASE_URL}"
echo "  Topology:   ${TOPOLOGY}"
echo "  Timeout:    ${TIMEOUT}s"
echo "  Workers:    ${WORKER_COUNT}"
echo "  Requirement: $(basename "$REQUIREMENT_FILE")"
echo ""

# ----------------------------------------------------------
# Pre-step: Record existing task IDs so we only track new ones
# ----------------------------------------------------------
PRE_EXISTING_TASK_IDS=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/tasks" 2>/dev/null | python3 -c "
import sys,json
tasks = json.load(sys.stdin).get('tasks',[])
for t in tasks:
    print(t.get('id',''))
" 2>/dev/null || echo "")
PRE_EXISTING_SET=""
for tid in $PRE_EXISTING_TASK_IDS; do
  PRE_EXISTING_SET="${PRE_EXISTING_SET},${tid}"
done
PRE_EXISTING_SET="${PRE_EXISTING_SET#,}"

# ----------------------------------------------------------
# Step 1: Submit requirement via controller intake
# ----------------------------------------------------------
echo -e "${BOLD}[1/5]${NC} Submitting requirement via controller/intake..."

# Truncate requirement for display
REQUIREMENT_PREVIEW=$(echo "$REQUIREMENT" | head -c 200)
echo -e "${DIM}  ${REQUIREMENT_PREVIEW}...${NC}"
echo ""

# Controller intake calls LLM which can take a long time; use a generous timeout
INTAKE_TIMEOUT=${INTAKE_TIMEOUT:-300}
INTAKE_STARTED_AT_MS=$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)
INTAKE_BODY_FILE=$(mktemp)
E2E_SESSION_KEY="$E2E_SESSION_KEY" python3 -c "import json, os, sys; print(json.dumps({'message': sys.stdin.read(), 'sessionKey': os.environ['E2E_SESSION_KEY']}))" \
  <<< "$REQUIREMENT" > "$INTAKE_BODY_FILE"
set +e
INTAKE_HTTP_CODE=$(curl -sS --max-time "$INTAKE_TIMEOUT" -o "${INTAKE_BODY_FILE}.response" -w '%{http_code}' \
  -X POST "${BASE_URL}/api/v1/controller/intake" \
  -H "Content-Type: application/json" \
  --data-binary @"$INTAKE_BODY_FILE")
CURL_STATUS=$?
set -e
INTAKE_RESPONSE=""
if [ -f "${INTAKE_BODY_FILE}.response" ]; then
  INTAKE_RESPONSE=$(cat "${INTAKE_BODY_FILE}.response")
fi
rm -f "$INTAKE_BODY_FILE" "${INTAKE_BODY_FILE}.response"

CONTROLLER_RUN_ID=""
REPLY=""

if [ "$CURL_STATUS" -eq 0 ] && [ "$INTAKE_HTTP_CODE" = "200" ]; then
  INTAKE_ERROR=$(echo "$INTAKE_RESPONSE" | python3 -c "
import sys,json
d = json.load(sys.stdin)
if 'error' in d:
    print(d['error'])
    sys.exit(0)
print('')
" 2>/dev/null || true)

  if [ -n "$INTAKE_ERROR" ]; then
    log_fail "Intake failed: ${INTAKE_ERROR}"
    exit 1
  fi

  CONTROLLER_RUN_ID=$(echo "$INTAKE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('controllerRunId',''))" 2>/dev/null || echo "")
  REPLY=$(echo "$INTAKE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply','')[:300])" 2>/dev/null || echo "")
fi

if [ -z "$CONTROLLER_RUN_ID" ]; then
  if [ "$CURL_STATUS" -ne 0 ]; then
    log_warn "Intake HTTP request did not complete cleanly (curl exit ${CURL_STATUS}); looking up the run by sessionKey=${E2E_SESSION_KEY}"
  else
    log_warn "Intake returned HTTP ${INTAKE_HTTP_CODE} without a usable controllerRunId; looking up the run by sessionKey=${E2E_SESSION_KEY}"
    [ -n "$INTAKE_RESPONSE" ] && echo -e "${DIM}  Response: $(echo "$INTAKE_RESPONSE" | head -c 300)${NC}"
  fi
  LOOKUP_ELAPSED=0
  while [ "$LOOKUP_ELAPSED" -lt 60 ] && [ -z "$CONTROLLER_RUN_ID" ]; do
    LOOKUP_RESULT=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/controller/runs" 2>/dev/null | python3 -c "
import json, sys
session_suffix = ':${E2E_SESSION_KEY}'
started_at = int('${INTAKE_STARTED_AT_MS}')
runs = json.load(sys.stdin).get('controllerRuns', [])
for run in runs:
    session_key = str(run.get('sessionKey', ''))
    created_at = int(run.get('createdAt', 0) or 0)
    if session_key.endswith(session_suffix) and created_at >= started_at - 1000:
        print(json.dumps({
            'id': run.get('id', ''),
            'reply': run.get('reply', '')[:300],
        }))
        sys.exit(0)
print('{}')
" 2>/dev/null || echo "{}")
    CONTROLLER_RUN_ID=$(echo "$LOOKUP_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    REPLY=$(echo "$LOOKUP_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null || echo "")
    [ -n "$CONTROLLER_RUN_ID" ] && break
    sleep 5
    LOOKUP_ELAPSED=$((LOOKUP_ELAPSED + 5))
  done
fi

if [ -z "$CONTROLLER_RUN_ID" ]; then
  log_fail "No controller run ID returned"
  exit 1
fi

log_pass "Intake accepted, controllerRunId=${CONTROLLER_RUN_ID}"
echo -e "${DIM}  Controller reply: ${REPLY}...${NC}"
echo ""

# ----------------------------------------------------------
# Step 2: Wait for controller intake to complete (task split)
# ----------------------------------------------------------
echo -e "${BOLD}[2/5]${NC} Waiting for controller to finish task splitting..."

INTAKE_DONE=false
ELAPSED=0
POLL_INTERVAL=5

while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  RUN_STATUS=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/controller/runs" 2>/dev/null | python3 -c "
import sys,json
runs = json.load(sys.stdin).get('controllerRuns',[])
for r in runs:
    if r.get('id') == '${CONTROLLER_RUN_ID}':
        print(r.get('status','unknown'))
        sys.exit(0)
print('not_found')
" 2>/dev/null || echo "error")

  if [ "$RUN_STATUS" = "completed" ]; then
    INTAKE_DONE=true
    break
  elif [ "$RUN_STATUS" = "failed" ]; then
    log_fail "Controller intake failed"
    echo -e "${DIM}  Check controller logs for details${NC}"
    exit 2
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))

  # Progress dot
  if [ $((ELAPSED % 30)) -eq 0 ] && [ "$ELAPSED" -gt 0 ]; then
    log_info "Still waiting... (${ELAPSED}s elapsed, run status=${RUN_STATUS})"
  fi
done

if [ "$INTAKE_DONE" = false ]; then
  log_fail "Controller intake timed out after ${TIMEOUT}s"
  exit 2
fi

log_pass "Controller intake completed (${ELAPSED}s)"

RUN_DETAILS=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/controller/runs" 2>/dev/null | python3 -c "
import json, sys
runs = json.load(sys.stdin).get('controllerRuns', [])
for run in runs:
    if run.get('id') == '${CONTROLLER_RUN_ID}':
        print(json.dumps({
            'projectDir': run.get('projectDir', ''),
            'createdTaskIds': run.get('createdTaskIds', []),
            'sessionKey': run.get('sessionKey', ''),
            'startedAt': run.get('startedAt', 0),
            'manifest': run.get('manifest') or {},
        }))
        sys.exit(0)
print('{}')
" 2>/dev/null || echo "{}")

PROJECT_DIR=$(echo "$RUN_DETAILS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('projectDir',''))" 2>/dev/null || echo "")
CREATED_TASK_SET=$(echo "$RUN_DETAILS" | python3 -c "import json,sys; print(','.join(json.load(sys.stdin).get('createdTaskIds', [])))" 2>/dev/null || echo "")
RUN_SESSION_KEY=$(echo "$RUN_DETAILS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionKey',''))" 2>/dev/null || echo "")
RUN_STARTED_AT=$(echo "$RUN_DETAILS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('startedAt', 0))" 2>/dev/null || echo "0")

if [ -z "$PROJECT_DIR" ] && [ -z "$CREATED_TASK_SET" ] && [ -z "$RUN_SESSION_KEY" ]; then
  log_fail "Controller run completed but exposed no projectDir, createdTaskIds, or sessionKey"
  exit 2
fi

# List tasks associated with this intake run
TASK_LIST=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/tasks" 2>/dev/null | python3 -c "
import sys,json
project_dir = '${PROJECT_DIR}'
created_ids = set('${CREATED_TASK_SET}'.strip(',').split(',')) if '${CREATED_TASK_SET}'.strip(',') else set()
session_key = '${RUN_SESSION_KEY}'
run_started_at = int('${RUN_STARTED_AT}' or '0')
tasks = json.load(sys.stdin).get('tasks',[])
tracked_tasks = [
    t for t in tasks
    if t.get('projectDir','') == project_dir
    or t.get('id','') in created_ids
    or (t.get('controllerSessionKey','') == session_key and int(t.get('updatedAt', 0) or 0) >= run_started_at)
]
if not tracked_tasks:
    print('NO_TASKS')
    sys.exit(0)
for t in tracked_tasks:
    status = t.get('status','?')
    role = t.get('assignedRole','?')
    title = t.get('title','?')[:60]
    tid = t.get('id','?')[:12]
    print(f'{tid}  {role:12s}  {status:12s}  {title}')
" 2>/dev/null || echo "PARSE_ERROR")

if [ "$TASK_LIST" = "NO_TASKS" ]; then
  log_fail "Controller did not create any tasks"
  exit 2
fi

TASK_COUNT=$(echo "$TASK_LIST" | wc -l | tr -d ' ')
echo "$TASK_LIST" | while read -r line; do
  echo -e "  ${DIM}${line}${NC}"
done
log_info "${TASK_COUNT} task(s) created"
echo ""

# ----------------------------------------------------------
# Step 3: Wait for all tasks to complete
# ----------------------------------------------------------
echo -e "${BOLD}[3/5]${NC} Waiting for all tasks to complete..."

ALL_DONE=false
ELAPSED=0
LAST_PRINT=0
LATEST_REQUIREMENT_COMPLETE=false
LATEST_CLARIFICATIONS_NEEDED=false
LATEST_DEFERRED_COUNT=0
ACTIVE_RUNS=0

while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  # Get task statuses
  STATUS_JSON=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/tasks" 2>/dev/null || echo "{}")
  RUNS_JSON=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/controller/runs" 2>/dev/null || echo "{}")

  COMPLETED=0
  FAILED=0
  BLOCKED=0
  PENDING=0
  TOTAL=$(echo "$STATUS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))" 2>/dev/null || echo "0")

  if [ "$TOTAL" -eq 0 ]; then
    # Possibly follow-up hasn't created downstream tasks yet
    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
    continue
  fi

  # Count statuses - use a single python call for atomicity
  STATUS_SUMMARY=$(echo "$STATUS_JSON" | python3 -c "
import sys,json
project_dir = '${PROJECT_DIR}'
created_ids = set('${CREATED_TASK_SET}'.strip(',').split(',')) if '${CREATED_TASK_SET}'.strip(',') else set()
session_key = '${RUN_SESSION_KEY}'
run_started_at = int('${RUN_STARTED_AT}' or '0')
tasks = json.load(sys.stdin).get('tasks',[])
tracked_tasks = [
    t for t in tasks
    if t.get('projectDir','') == project_dir
    or t.get('id','') in created_ids
    or (t.get('controllerSessionKey','') == session_key and int(t.get('updatedAt', 0) or 0) >= run_started_at)
]
completed = sum(1 for t in tracked_tasks if t.get('status') in ('completed','delivered'))
failed = sum(1 for t in tracked_tasks if t.get('status') == 'failed')
blocked = sum(1 for t in tracked_tasks if t.get('status') == 'blocked')
pending = sum(1 for t in tracked_tasks if t.get('status') in ('pending','assigned','in_progress'))
print(f'{completed},{failed},{blocked},{pending},{len(tracked_tasks)}')
" 2>/dev/null || echo "0,0,0,0,0")

  COMPLETED=$(echo "$STATUS_SUMMARY" | cut -d, -f1)
  FAILED=$(echo "$STATUS_SUMMARY" | cut -d, -f2)
  BLOCKED=$(echo "$STATUS_SUMMARY" | cut -d, -f3)
  PENDING=$(echo "$STATUS_SUMMARY" | cut -d, -f4)
  TOTAL=$(echo "$STATUS_SUMMARY" | cut -d, -f5)

  RUN_SUMMARY=$(PROJECT_DIR="$PROJECT_DIR" RUN_SESSION_KEY="$RUN_SESSION_KEY" RUN_STARTED_AT="$RUN_STARTED_AT" python3 -c '
import json
import os
import sys

runs_json = json.load(sys.stdin)
project_dir = os.environ["PROJECT_DIR"]
session_key = os.environ["RUN_SESSION_KEY"]
run_started_at = int(os.environ.get("RUN_STARTED_AT") or "0")
runs = runs_json.get("controllerRuns", [])
related = [
    r for r in runs
    if (
        r.get("projectDir", "") == project_dir
        or (r.get("sessionKey", "") == session_key and int(r.get("updatedAt", 0) or 0) >= run_started_at)
    )
]
related.sort(key=lambda r: int(r.get("updatedAt", 0) or 0), reverse=True)
active = sum(1 for r in related if r.get("status") in ("pending", "running"))
latest = related[0] if related else {}
manifest = latest.get("manifest") if isinstance(latest.get("manifest"), dict) else {}
print(",".join([
    str(active),
    "1" if bool(manifest.get("requirementFullyComplete")) else "0",
    "1" if bool(manifest.get("clarificationsNeeded")) else "0",
    str(len(manifest.get("deferredTasks") or [])),
    str(len(related)),
]))
' <<<"$RUNS_JSON")

  ACTIVE_RUNS=$(echo "$RUN_SUMMARY" | cut -d, -f1)
  if [ "$(echo "$RUN_SUMMARY" | cut -d, -f2)" = "1" ]; then
    LATEST_REQUIREMENT_COMPLETE=true
  else
    LATEST_REQUIREMENT_COMPLETE=false
  fi
  if [ "$(echo "$RUN_SUMMARY" | cut -d, -f3)" = "1" ]; then
    LATEST_CLARIFICATIONS_NEEDED=true
  else
    LATEST_CLARIFICATIONS_NEEDED=false
  fi
  LATEST_DEFERRED_COUNT=$(echo "$RUN_SUMMARY" | cut -d, -f4)

  # Print progress every 30s
  if [ $((ELAPSED - LAST_PRINT)) -ge 30 ]; then
    log_info "Progress: ${COMPLETED}/${TOTAL} completed, ${FAILED} failed, ${PENDING} pending, active runs=${ACTIVE_RUNS} (${ELAPSED}s)"
    LAST_PRINT=$ELAPSED
  fi

  # Check if the entire requirement is complete, not just the currently visible tasks.
  # Prefer the controller's explicit requirementFullyComplete signal, but tolerate
  # older/partial manifests when all related tasks and follow-up runs have already
  # reached terminal state with no failures, blockers, clarifications, or deferred work.
  if [ "$PENDING" -eq 0 ] && [ "$BLOCKED" -eq 0 ] && [ "$ACTIVE_RUNS" -eq 0 ] \
    && [ "$LATEST_CLARIFICATIONS_NEEDED" = false ] && [ "${LATEST_DEFERRED_COUNT}" -eq 0 ] \
    && { [ "$LATEST_REQUIREMENT_COMPLETE" = true ] || [ "$FAILED" -eq 0 ]; }; then
    ALL_DONE=true
    break
  fi

  # Bail on failure
  if [ "$FAILED" -gt 0 ] && [ "$PENDING" -eq 0 ] && [ "$BLOCKED" -eq 0 ]; then
    ALL_DONE=true
    break
  fi

  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

if [ "$ALL_DONE" = false ]; then
  log_fail "Tasks did not complete within ${TIMEOUT}s"
  log_info "Final state: ${COMPLETED}/${TOTAL} completed, ${FAILED} failed, ${PENDING} pending, active runs=${ACTIVE_RUNS}, requirementFullyComplete=${LATEST_REQUIREMENT_COMPLETE}, clarificationsNeeded=${LATEST_CLARIFICATIONS_NEEDED}, deferred=${LATEST_DEFERRED_COUNT}"

  # Print current task states
  echo "$STATUS_JSON" | python3 -c "
import sys,json
project_dir = '${PROJECT_DIR}'
created_ids = set('${CREATED_TASK_SET}'.strip(',').split(',')) if '${CREATED_TASK_SET}'.strip(',') else set()
session_key = '${RUN_SESSION_KEY}'
run_started_at = int('${RUN_STARTED_AT}' or '0')
tasks = json.load(sys.stdin).get('tasks',[])
for t in tasks:
    if (
        t.get('projectDir','') != project_dir
        and t.get('id','') not in created_ids
        and not (t.get('controllerSessionKey','') == session_key and int(t.get('updatedAt', 0) or 0) >= run_started_at)
    ):
        continue
    status = t.get('status','?')
    role = t.get('assignedRole','?')
    title = t.get('title','?')[:60]
    tid = t.get('id','?')[:12]
    print(f'  {tid}  {role:12s}  {status:12s}  {title}')
" 2>/dev/null || true
  exit 2
fi

log_pass "Requirement reached terminal complete state (${ELAPSED}s): ${COMPLETED} completed, ${FAILED} failed"
echo ""

# ----------------------------------------------------------
# Step 4: Validate task execution details
# ----------------------------------------------------------
echo -e "${BOLD}[4/5]${NC} Validating task execution details..."

VALIDATION_OUTPUT=$(STATUS_JSON="$STATUS_JSON" BASE_URL="$BASE_URL" PROJECT_DIR="$PROJECT_DIR" CREATED_TASK_SET="$CREATED_TASK_SET" RUN_SESSION_KEY="$RUN_SESSION_KEY" RUN_STARTED_AT="$RUN_STARTED_AT" python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base_url = os.environ["BASE_URL"].rstrip("/")
project_dir = os.environ["PROJECT_DIR"]
created_ids = set(filter(None, os.environ["CREATED_TASK_SET"].strip(",").split(",")))
session_key = os.environ["RUN_SESSION_KEY"]
run_started_at = int(os.environ.get("RUN_STARTED_AT") or "0")
status_json = json.loads(os.environ["STATUS_JSON"])

tracked_tasks = []
for task in status_json.get("tasks", []):
    updated_at = int(task.get("updatedAt", 0) or 0)
    if (
        task.get("projectDir", "") == project_dir
        or task.get("id", "") in created_ids
        or (task.get("controllerSessionKey", "") == session_key and updated_at >= run_started_at)
    ):
        tracked_tasks.append(task)

validation_passed = 0
validation_failed = 0
warnings: list[str] = []

for task in tracked_tasks:
    task_id = task.get("id", "")
    if not task_id:
        continue

    try:
        with urllib.request.urlopen(f"{base_url}/api/v1/tasks/{task_id}/execution", timeout=10) as response:
            detail = json.load(response)
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as err:
        validation_failed += 2
        warnings.append(f"Task {task_id}: execution detail unavailable ({err})")
        continue

    detail_task = detail.get("task") if isinstance(detail, dict) else {}
    if not isinstance(detail_task, dict):
        detail_task = {}
    execution = detail_task.get("execution") if isinstance(detail_task.get("execution"), dict) else {}
    events = execution.get("events") if isinstance(execution.get("events"), list) else []
    result_contract = detail_task.get("resultContract")
    result_text = detail_task.get("result")
    result_text_norm = result_text.strip() if isinstance(result_text, str) else ""
    result_text_lower = result_text_norm.lower()

    has_events = len(events) > 0
    has_result = bool(result_contract) or bool(result_text_norm)
    if not has_result:
        for event in events:
            if not isinstance(event, dict):
                continue
            phase = str(event.get("phase", ""))
            if phase in ("result_submitted", "result_contract_backfilled", "result_completed", "completed"):
                has_result = True
                break

    if has_events:
        validation_passed += 1
    else:
        validation_failed += 1
        warnings.append(f"Task {task_id}: no execution events")

    if has_result:
        validation_passed += 1
    else:
        validation_failed += 1
        warnings.append(f"Task {task_id}: no result submitted")

    if result_text_norm and (
        "please approve the command" in result_text_lower
        or "/approve " in result_text_lower
        or result_text_lower.startswith("no_reply")
    ):
        validation_failed += 1
        warnings.append(f"Task {task_id}: result contains approval prompt or NO_REPLY placeholder")
    else:
        validation_passed += 1

print(f"TOTAL_CHECKS={len(tracked_tasks)}")
print(f"VALIDATION_PASSED={validation_passed}")
print(f"VALIDATION_FAILED={validation_failed}")
for warning in warnings:
    print(f"WARNING={warning}")
PY
)

TOTAL_CHECKS=$(printf '%s\n' "$VALIDATION_OUTPUT" | awk -F= '/^TOTAL_CHECKS=/{print $2; exit}')
VALIDATION_PASSED=$(printf '%s\n' "$VALIDATION_OUTPUT" | awk -F= '/^VALIDATION_PASSED=/{print $2; exit}')
VALIDATION_FAILED=$(printf '%s\n' "$VALIDATION_OUTPUT" | awk -F= '/^VALIDATION_FAILED=/{print $2; exit}')

[ -z "$TOTAL_CHECKS" ] && TOTAL_CHECKS=0
[ -z "$VALIDATION_PASSED" ] && VALIDATION_PASSED=0
[ -z "$VALIDATION_FAILED" ] && VALIDATION_FAILED=0

printf '%s\n' "$VALIDATION_OUTPUT" | awk -F= '/^WARNING=/{print substr($0,9)}' | while read -r WARNING_LINE; do
  [ -z "$WARNING_LINE" ] && continue
  log_warn "$WARNING_LINE"
done

if [ "$VALIDATION_FAILED" -eq 0 ] && [ "$TOTAL_CHECKS" -gt 0 ]; then
  log_pass "All ${TOTAL_CHECKS} tasks have execution events and results"
elif [ "$TOTAL_CHECKS" -eq 0 ]; then
  log_warn "No tasks to validate"
else
  log_fail "${VALIDATION_FAILED}/${TOTAL_CHECKS} tasks have validation issues"
fi
echo ""

# ----------------------------------------------------------
# Step 5: Check git collaboration (for distributed topologies)
# ----------------------------------------------------------
echo -e "${BOLD}[5/5]${NC} Checking workspace state..."

# Check git repo status
GIT_STATUS=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/git/status" 2>/dev/null || echo "{}")
GIT_ENABLED=$(echo "$GIT_STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('enabled',False))" 2>/dev/null || echo "False")

if [ "$GIT_ENABLED" = "True" ]; then
  BRANCH=$(echo "$GIT_STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('branch','unknown'))" 2>/dev/null || echo "unknown")
  COMMIT_COUNT=$(echo "$GIT_STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('commitCount',0))" 2>/dev/null || echo "0")

  if [ "$COMMIT_COUNT" -gt 0 ]; then
    log_pass "Git repo active: branch=${BRANCH}, commits=${COMMIT_COUNT}"
  else
    log_warn "Git enabled but no commits found"
  fi
else
  log_skip "Git not enabled in this configuration"
fi

echo ""

# ----------------------------------------------------------
# Summary
# ----------------------------------------------------------
echo -e "${BOLD}${CYAN}════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Delivery Test Summary${NC}"
echo -e "${BOLD}${CYAN}════════════════════════════════════════════════${NC}"
echo "  Requirement:  $(basename "$REQUIREMENT_FILE")"
echo "  Tasks created: ${TASK_COUNT}"
echo "  Completed:     ${COMPLETED}"
echo "  Failed:        ${FAILED}"
echo "  Total time:    ${ELAPSED}s"
echo ""

# Print final task list with results (only new tasks from this intake)
echo "$STATUS_JSON" | python3 -c "
import sys,json
project_dir = '${PROJECT_DIR}'
created_ids = set('${CREATED_TASK_SET}'.strip(',').split(',')) if '${CREATED_TASK_SET}'.strip(',') else set()
session_key = '${RUN_SESSION_KEY}'
run_started_at = int('${RUN_STARTED_AT}' or '0')
tasks = json.load(sys.stdin).get('tasks',[])
for t in tasks:
    if (
        t.get('projectDir','') != project_dir
        and t.get('id','') not in created_ids
        and not (t.get('controllerSessionKey','') == session_key and int(t.get('updatedAt', 0) or 0) >= run_started_at)
    ):
        continue
    status = t.get('status','?')
    role = t.get('assignedRole','?')
    title = t.get('title','?')[:80]
    tid = t.get('id','?')[:12]
    worker = (t.get('assignedWorkerId','?') or '?')[:12]
    result = t.get('result','')[:100] if t.get('result') else ''
    print(f'  [{status:10s}] {role:12s}  {title}')
    if result:
        print(f'                result: {result}')
" 2>/dev/null || true

echo ""

if [ -n "${E2E_SUMMARY_FILE:-}" ]; then
  if [ "$LATEST_REQUIREMENT_COMPLETE" = true ]; then
    SUMMARY_REQUIREMENT_COMPLETE=True
  else
    SUMMARY_REQUIREMENT_COMPLETE=False
  fi
  if [ "$LATEST_CLARIFICATIONS_NEEDED" = true ]; then
    SUMMARY_CLARIFICATIONS_NEEDED=True
  else
    SUMMARY_CLARIFICATIONS_NEEDED=False
  fi
  python3 - <<PY > "$E2E_SUMMARY_FILE"
import json

summary = {
    "requirementFile": "$(basename "$REQUIREMENT_FILE")",
    "controllerRunId": "${CONTROLLER_RUN_ID}",
    "projectDir": "${PROJECT_DIR}",
    "createdTaskIds": [v for v in "${CREATED_TASK_SET}".split(",") if v],
    "sessionKey": "${RUN_SESSION_KEY}",
    "startedAt": int("${RUN_STARTED_AT}" or "0"),
    "taskCount": int("${TASK_COUNT}" or "0"),
    "completed": int("${COMPLETED}" or "0"),
    "failed": int("${FAILED}" or "0"),
    "blocked": int("${BLOCKED}" or "0"),
    "pending": int("${PENDING}" or "0"),
    "elapsed": int("${ELAPSED}" or "0"),
    "validationPassed": int("${VALIDATION_PASSED}" or "0"),
    "validationFailed": int("${VALIDATION_FAILED}" or "0"),
    "requirementFullyComplete": ${SUMMARY_REQUIREMENT_COMPLETE},
    "clarificationsNeeded": ${SUMMARY_CLARIFICATIONS_NEEDED},
    "deferredTasks": int("${LATEST_DEFERRED_COUNT}" or "0"),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY
  log_info "Wrote E2E summary to ${E2E_SUMMARY_FILE}"
fi

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}${BOLD}RESULT: FAIL (${FAILED} task(s) failed)${NC}"
  exit 2
elif [ "$VALIDATION_FAILED" -gt 0 ]; then
  echo -e "${RED}${BOLD}RESULT: FAIL (validation detected incomplete/placeholder task output)${NC}"
  exit 2
elif [ "$LATEST_REQUIREMENT_COMPLETE" != true ] || [ "$LATEST_CLARIFICATIONS_NEEDED" = true ] || [ "${LATEST_DEFERRED_COUNT}" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}RESULT: INCOMPLETE (requirement not fully complete)${NC}"
  exit 2
elif [ "$PENDING" -gt 0 ] || [ "$BLOCKED" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}RESULT: INCOMPLETE (some tasks still pending/blocked)${NC}"
  exit 2
else
  echo -e "${GREEN}${BOLD}RESULT: PASS (all tasks completed)${NC}"
  exit 0
fi
