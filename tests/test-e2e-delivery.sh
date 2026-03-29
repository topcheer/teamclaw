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
#   topology          "single-instance" | "distributed" (default: distributed)
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

# Check workers
TEAM_STATUS=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "{}")
WORKER_COUNT=$(echo "$TEAM_STATUS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('workers',[])))" 2>/dev/null || echo "0")
if [ "$WORKER_COUNT" -eq 0 ]; then
  echo -e "${RED}ERROR: No workers registered${NC}"
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
INTAKE_RESPONSE=$(curl -s --max-time "$INTAKE_TIMEOUT" -w '\n%{http_code}' -X POST "${BASE_URL}/api/v1/controller/intake" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "import sys,json; print(json.dumps({'message': sys.stdin.read()}))" <<< "$REQUIREMENT")" 2>/dev/null || echo "{}")

INTAKE_HTTP_CODE=$(echo "$INTAKE_RESPONSE" | tail -1)
INTAKE_RESPONSE=$(echo "$INTAKE_RESPONSE" | sed '$d')

if [ "$INTAKE_HTTP_CODE" != "200" ]; then
  log_fail "Intake returned HTTP ${INTAKE_HTTP_CODE}"
  echo -e "${DIM}  Response: $(echo "$INTAKE_RESPONSE" | head -c 500)${NC}"
  exit 1
fi

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

# List NEW tasks (created by this intake, not pre-existing from API tests)
TASK_LIST=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/tasks" 2>/dev/null | python3 -c "
import sys,json
pre_existing = set('${PRE_EXISTING_SET}'.strip(',').split(',')) if '${PRE_EXISTING_SET}'.strip(',') else set()
tasks = json.load(sys.stdin).get('tasks',[])
new_tasks = [t for t in tasks if t.get('id','') not in pre_existing]
if not new_tasks:
    print('NO_TASKS')
    sys.exit(0)
for t in new_tasks:
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

while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  # Get task statuses
  STATUS_JSON=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/tasks" 2>/dev/null || echo "{}")

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
  # Only count NEW tasks (not pre-existing from API tests)
  STATUS_SUMMARY=$(echo "$STATUS_JSON" | python3 -c "
import sys,json
pre_existing = set('${PRE_EXISTING_SET}'.strip(',').split(',')) if '${PRE_EXISTING_SET}'.strip(',') else set()
tasks = json.load(sys.stdin).get('tasks',[])
new_tasks = [t for t in tasks if t.get('id','') not in pre_existing]
completed = sum(1 for t in new_tasks if t.get('status') in ('completed','delivered'))
failed = sum(1 for t in new_tasks if t.get('status') == 'failed')
blocked = sum(1 for t in new_tasks if t.get('status') == 'blocked')
pending = sum(1 for t in new_tasks if t.get('status') in ('pending','assigned','in_progress'))
print(f'{completed},{failed},{blocked},{pending},{len(new_tasks)}')
" 2>/dev/null || echo "0,0,0,0,0")

  COMPLETED=$(echo "$STATUS_SUMMARY" | cut -d, -f1)
  FAILED=$(echo "$STATUS_SUMMARY" | cut -d, -f2)
  BLOCKED=$(echo "$STATUS_SUMMARY" | cut -d, -f3)
  PENDING=$(echo "$STATUS_SUMMARY" | cut -d, -f4)
  TOTAL=$(echo "$STATUS_SUMMARY" | cut -d, -f5)

  # Print progress every 30s
  if [ $((ELAPSED - LAST_PRINT)) -ge 30 ]; then
    log_info "Progress: ${COMPLETED}/${TOTAL} completed, ${FAILED} failed, ${PENDING} pending (${ELAPSED}s)"
    LAST_PRINT=$ELAPSED
  fi

  # Check if all done (no pending or blocked tasks)
  if [ "$PENDING" -eq 0 ] && [ "$BLOCKED" -eq 0 ]; then
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
  log_info "Final state: ${COMPLETED}/${TOTAL} completed, ${FAILED} failed, ${PENDING} pending"

  # Print current task states
  echo "$STATUS_JSON" | python3 -c "
import sys,json
tasks = json.load(sys.stdin).get('tasks',[])
for t in tasks:
    status = t.get('status','?')
    role = t.get('assignedRole','?')
    title = t.get('title','?')[:60]
    tid = t.get('id','?')[:12]
    print(f'  {tid}  {role:12s}  {status:12s}  {title}')
" 2>/dev/null || true
  exit 2
fi

log_pass "All tasks reached terminal state (${ELAPSED}s): ${COMPLETED} completed, ${FAILED} failed"
echo ""

# ----------------------------------------------------------
# Step 4: Validate task execution details
# ----------------------------------------------------------
echo -e "${BOLD}[4/5]${NC} Validating task execution details..."

VALIDATION_PASSED=0
VALIDATION_FAILED=0
TOTAL_CHECKS=0

echo "$STATUS_JSON" | python3 -c "
import sys,json
pre_existing = set('${PRE_EXISTING_SET}'.strip(',').split(',')) if '${PRE_EXISTING_SET}'.strip(',') else set()
tasks = json.load(sys.stdin).get('tasks',[])
for t in tasks:
    if t.get('id','') in pre_existing:
        continue
    tid = t.get('id','')
    status = t.get('status','?')
    role = t.get('assignedRole','?')
    title = t.get('title','?')[:60]
    print(f'{tid}')
" 2>/dev/null | while read -r TID; do
  [ -z "$TID" ] && continue

  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))

  # Get execution detail
  EXEC_DETAIL=$(curl -sf --max-time 10 "${BASE_URL}/api/v1/tasks/${TID}/execution" 2>/dev/null || echo "{}")

  EVENT_COUNT=$(echo "$EXEC_DETAIL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('events',[])))" 2>/dev/null || echo "0")
  HAS_RESULT=$(echo "$EXEC_DETAIL" | python3 -c "
import sys,json
d = json.load(sys.stdin)
events = d.get('events',[])
# Check if there's a result event
for e in events:
    phase = e.get('phase','')
    if phase in ('result_submitted', 'completed'):
        print('yes')
        sys.exit(0)
print('no')
" 2>/dev/null || echo "no")

  if [ "$EVENT_COUNT" -gt 0 ]; then
    VALIDATION_PASSED=$((VALIDATION_PASSED + 1))
  else
    VALIDATION_FAILED=$((VALIDATION_FAILED + 1))
    log_warn "Task ${TID}: no execution events"
  fi

  if [ "$HAS_RESULT" = "yes" ]; then
    VALIDATION_PASSED=$((VALIDATION_PASSED + 1))
  else
    VALIDATION_FAILED=$((VALIDATION_FAILED + 1))
    log_warn "Task ${TID}: no result submitted"
  fi
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

if [ "$TOPOLOGY" = "single-instance" ]; then
  log_skip "Git collaboration not expected for single-instance topology"
else
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
pre_existing = set('${PRE_EXISTING_SET}'.strip(',').split(',')) if '${PRE_EXISTING_SET}'.strip(',') else set()
tasks = json.load(sys.stdin).get('tasks',[])
for t in tasks:
    if t.get('id','') in pre_existing:
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

if [ "$FAILED" -gt 0 ]; then
  echo -e "${RED}${BOLD}RESULT: FAIL (${FAILED} task(s) failed)${NC}"
  exit 2
elif [ "$PENDING" -gt 0 ] || [ "$BLOCKED" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}RESULT: INCOMPLETE (some tasks still pending/blocked)${NC}"
  exit 2
else
  echo -e "${GREEN}${BOLD}RESULT: PASS (all tasks completed)${NC}"
  exit 0
fi
