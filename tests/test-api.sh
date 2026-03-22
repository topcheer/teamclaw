#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# TeamClaw Plugin API Tests
# ============================================================
# Executes 14 test scenarios against a running Controller.
# Usage: bash test-api.sh [BASE_URL]
#   BASE_URL defaults to http://localhost:9527
# ============================================================

BASE_URL="${1:-http://localhost:9527}"
PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
  RESULTS+=("PASS: $1")
}

log_fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  RESULTS+=("FAIL: $1")
}

log_skip() {
  echo -e "  ${YELLOW}SKIP${NC} $1"
  RESULTS+=("SKIP: $1")
}

log_info() {
  echo -e "  ${CYAN}INFO${NC} $1"
}

# Wait for healthy response
wait_for_health() {
  local max_attempts="${1:-30}"
  local interval="${2:-2}"
  for i in $(seq 1 "$max_attempts"); do
    if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
      return 0
    fi
    sleep "$interval"
  done
  return 1
}

# ============================================================
echo -e "\n${CYAN}=== TeamClaw API Test Suite ===${NC}"
echo -e "  Target: ${BASE_URL}"
echo ""

# ----------------------------------------------------------
# Test 1: Controller Health Check
# ----------------------------------------------------------
echo -e "${CYAN}[1/14]${NC} Controller health check"

if wait_for_health 30 2; then
  BODY=$(curl -sf "${BASE_URL}/api/v1/health")
  MODE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null || echo "")
  if [ "$MODE" = "controller" ]; then
    log_pass "Controller is healthy, mode=controller"
  else
    log_fail "Controller responded but mode='${MODE}', expected 'controller'"
  fi
else
  log_fail "Controller did not become healthy within timeout"
fi

# ----------------------------------------------------------
# Test 2: Worker Registration (wait for 3 workers)
# ----------------------------------------------------------
echo -e "${CYAN}[2/14]${NC} Worker registration (waiting for 3 workers)"

log_info "Waiting 15s for workers to register and send heartbeats..."
sleep 15

WORKERS_BODY=$(curl -sf "${BASE_URL}/api/v1/workers" 2>/dev/null || echo "{}")
WORKER_COUNT=$(echo "$WORKERS_BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('workers',[])))" 2>/dev/null || echo "0")

if [ "$WORKER_COUNT" -ge 3 ]; then
  log_pass "${WORKER_COUNT} workers registered (expected >= 3)"

  # Show worker details
  echo "$WORKERS_BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for w in data.get('workers', []):
    print(f'    - {w[\"id\"][:20]}... role={w[\"role\"]} status={w[\"status\"]}')
" 2>/dev/null || true
else
  log_fail "Only ${WORKER_COUNT} workers registered, expected 3"
fi

# ----------------------------------------------------------
# Test 3: Create Task + Auto-assign
# ----------------------------------------------------------
echo -e "${CYAN}[3/14]${NC} Create task with auto-assignment"

TASK_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement user login feature",
    "description": "Add login/logout functionality with JWT tokens",
    "priority": "high",
    "assignedRole": "developer",
    "createdBy": "test-runner"
  }' 2>/dev/null || echo "{}")

TASK_STATUS=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")
TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$TASK_ID" ] && [ "$TASK_STATUS" = "assigned" ]; then
  log_pass "Task created and auto-assigned, status=${TASK_STATUS}, id=${TASK_ID:0:20}..."
else
  log_fail "Task creation issue: status='${TASK_STATUS}', id='${TASK_ID}' (may have no matching worker for role)"
  # Not a hard failure if no developer worker matched - task is still created
  if [ -n "$TASK_ID" ]; then
    log_info "Task was created (id=${TASK_ID:0:20}...) but not auto-assigned"
  fi
fi

# ----------------------------------------------------------
# Test 4: Get Task List
# ----------------------------------------------------------
echo -e "${CYAN}[4/14]${NC} Get task list"

TASKS_BODY=$(curl -sf "${BASE_URL}/api/v1/tasks" 2>/dev/null || echo "{}")
TASKS_COUNT=$(echo "$TASKS_BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))" 2>/dev/null || echo "0")

if [ "$TASKS_COUNT" -ge 1 ]; then
  log_pass "Task list returned ${TASKS_COUNT} task(s)"
else
  log_fail "Task list returned ${TASKS_COUNT} tasks, expected >= 1"
fi

# ----------------------------------------------------------
# Test 5: Direct Message Routing
# ----------------------------------------------------------
echo -e "${CYAN}[5/14]${NC} Direct message routing"

MSG_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/messages/direct" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "test-runner",
    "fromRole": "pm",
    "toRole": "developer",
    "content": "Please review the login feature implementation",
    "taskId": "'"${TASK_ID}"'"
  }' 2>/dev/null || echo "{}")

MSG_STATUS=$(echo "$MSG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

if [ "$MSG_STATUS" = "delivered" ] || [ "$MSG_STATUS" = "no-target" ]; then
  log_pass "Direct message sent, status=${MSG_STATUS}"
else
  log_fail "Direct message failed, status='${MSG_STATUS}'"
fi

# ----------------------------------------------------------
# Test 6: Broadcast Message
# ----------------------------------------------------------
echo -e "${CYAN}[6/14]${NC} Broadcast message"

BCAST_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/messages/broadcast" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "test-runner",
    "fromRole": "pm",
    "content": "Team standup: all hands on deck for release prep"
  }' 2>/dev/null || echo "{}")

BCAST_RECIPIENTS=$(echo "$BCAST_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('recipients',0))" 2>/dev/null || echo "0")

if [ "$BCAST_RECIPIENTS" -gt 0 ]; then
  log_pass "Broadcast delivered to ${BCAST_RECIPIENTS} recipient(s)"
elif [ "$WORKER_COUNT" -eq 0 ]; then
  log_skip "No workers available for broadcast"
else
  log_fail "Broadcast delivered to ${BCAST_RECIPIENTS} recipients, expected > 0"
fi

# ----------------------------------------------------------
# Test 7: Review Request
# ----------------------------------------------------------
echo -e "${CYAN}[7/14]${NC} Review request message"

REVIEW_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/messages/review-request" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "test-runner",
    "fromRole": "developer",
    "toRole": "qa",
    "content": "Login feature ready for QA review",
    "taskId": "'"${TASK_ID}"'"
  }' 2>/dev/null || echo "{}")

REVIEW_STATUS=$(echo "$REVIEW_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

if [ "$REVIEW_STATUS" = "delivered" ] || [ "$REVIEW_STATUS" = "no-target" ]; then
  log_pass "Review request sent, status=${REVIEW_STATUS}"
else
  log_fail "Review request failed, status='${REVIEW_STATUS}'"
fi

# ----------------------------------------------------------
# Test 8: Task Handoff
# ----------------------------------------------------------
echo -e "${CYAN}[8/14]${NC} Task handoff"

if [ -n "$TASK_ID" ]; then
  HANDOFF_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks/${TASK_ID}/handoff" \
    -H "Content-Type: application/json" \
    -d '{
      "targetRole": "qa"
    }' 2>/dev/null || echo "{}")

  HANDOFF_STATUS=$(echo "$HANDOFF_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")

  if [ "$HANDOFF_STATUS" = "assigned" ] || [ "$HANDOFF_STATUS" = "pending" ]; then
    log_pass "Task handed off, new status=${HANDOFF_STATUS}"
  else
    log_fail "Task handoff unexpected status='${HANDOFF_STATUS}'"
  fi
else
  log_skip "No task ID available for handoff test"
fi

# ----------------------------------------------------------
# Test 9: Task Result Submission
# ----------------------------------------------------------
echo -e "${CYAN}[9/14]${NC} Task result submission"

if [ -n "$TASK_ID" ]; then
  RESULT_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks/${TASK_ID}/result" \
    -H "Content-Type: application/json" \
    -d '{
      "result": "Login feature implemented with JWT authentication"
    }' 2>/dev/null || echo "{}")

  RESULT_STATUS=$(echo "$RESULT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")

  if [ "$RESULT_STATUS" = "completed" ]; then
    log_pass "Task completed, status=${RESULT_STATUS}"
  else
    log_fail "Task result submission unexpected status='${RESULT_STATUS}'"
  fi
else
  log_skip "No task ID available for result submission"
fi

# ----------------------------------------------------------
# Test 10: Worker Heartbeat Timeout
# ----------------------------------------------------------
echo -e "${CYAN}[10/14]${NC} Worker heartbeat timeout detection"

if [ "$WORKER_COUNT" -gt 0 ]; then
  # Get first worker ID
  WORKER_ID=$(echo "$WORKERS_BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
workers = data.get('workers', [])
if workers:
    print(workers[0]['id'])
" 2>/dev/null || echo "")

  if [ -n "$WORKER_ID" ]; then
    # Stop a worker container to simulate heartbeat timeout
    WORKER_CONTAINER=""
    for c in tc-worker-dev tc-worker-qa tc-worker-arch; do
      # Check which container has this worker ID via logs
      if docker logs "$c" 2>/dev/null | grep -q "$WORKER_ID"; then
        WORKER_CONTAINER="$c"
        break
      fi
    done

    if [ -n "$WORKER_CONTAINER" ]; then
      log_info "Stopping container ${WORKER_CONTAINER} to test timeout..."
      docker stop "$WORKER_CONTAINER" > /dev/null 2>&1 || true

      log_info "Waiting 35s for heartbeat timeout (WORKER_TIMEOUT_MS=30000)..."
      sleep 35

      UPDATED_BODY=$(curl -sf "${BASE_URL}/api/v1/workers" 2>/dev/null || echo "{}")
      WORKER_FOUND=$(echo "$UPDATED_BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for w in data.get('workers', []):
    if w['id'] == '${WORKER_ID}':
        print(w.get('status', ''))
        break
" 2>/dev/null || echo "")

      if [ "$WORKER_FOUND" = "offline" ]; then
        log_pass "Worker ${WORKER_ID:0:20}... detected as offline after heartbeat timeout"
      elif [ -z "$WORKER_FOUND" ]; then
        log_pass "Worker ${WORKER_ID:0:20}... removed from active list"
      else
        log_fail "Worker status='${WORKER_FOUND}', expected 'offline'"
      fi

      # Restart the worker
      log_info "Restarting ${WORKER_CONTAINER}..."
      docker start "$WORKER_CONTAINER" > /dev/null 2>&1 || true
    else
      log_skip "Could not identify which container owns worker ${WORKER_ID:0:20}..."
    fi
  else
    log_skip "No worker ID available for timeout test"
  fi
else
  log_skip "No workers registered for timeout test"
fi

# ----------------------------------------------------------
# Test 11: Roles List
# ----------------------------------------------------------
echo -e "${CYAN}[11/14]${NC} Roles list"

ROLES_BODY=$(curl -sf "${BASE_URL}/api/v1/roles" 2>/dev/null || echo "{}")
ROLES_COUNT=$(echo "$ROLES_BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('roles',[])))" 2>/dev/null || echo "0")

if [ "$ROLES_COUNT" -eq 8 ]; then
  log_pass "Roles list returned ${ROLES_COUNT} roles"
  echo "$ROLES_BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('roles', []):
    print(f'    - {r[\"id\"]:20s} {r[\"label\"]}')
" 2>/dev/null || true
else
  log_fail "Roles list returned ${ROLES_COUNT} roles, expected 8"
fi

# ----------------------------------------------------------
# Test 12: Team Status
# ----------------------------------------------------------
echo -e "${CYAN}[12/14]${NC} Team status"

STATUS_BODY=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "{}")
TEAM_NAME=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('teamName',''))" 2>/dev/null || echo "")
HAS_WORKERS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'workers' in d else 'no')" 2>/dev/null || echo "no")
HAS_TASKS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'tasks' in d else 'no')" 2>/dev/null || echo "no")

if [ -n "$TEAM_NAME" ] && [ "$HAS_WORKERS" = "yes" ] && [ "$HAS_TASKS" = "yes" ]; then
  STATUS_WORKERS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerCount',0))" 2>/dev/null || echo "0")
  STATUS_TASKS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('taskCount',0))" 2>/dev/null || echo "0")
  log_pass "Team status: name=${TEAM_NAME}, workers=${STATUS_WORKERS}, tasks=${STATUS_TASKS}"
else
  log_fail "Team status incomplete: name='${TEAM_NAME}', workers=${HAS_WORKERS}, tasks=${HAS_TASKS}"
fi

# ----------------------------------------------------------
# Test 13: Web UI Accessible
# ----------------------------------------------------------
echo -e "${CYAN}[13/14]${NC} Web UI accessible"

UI_HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "${BASE_URL}/ui" 2>/dev/null || echo "000")

if [ "$UI_HTTP_CODE" = "200" ]; then
  log_pass "Web UI returned HTTP 200"
else
  log_fail "Web UI returned HTTP ${UI_HTTP_CODE}, expected 200"
fi

# ----------------------------------------------------------
# Test 14: Worker Removal
# ----------------------------------------------------------
echo -e "${CYAN}[14/14]${NC} Worker removal"

if [ -n "$WORKER_ID" ]; then
  REMOVE_RESPONSE=$(curl -sf -X DELETE "${BASE_URL}/api/v1/workers/${WORKER_ID}" 2>/dev/null || echo "{}")
  REMOVE_STATUS=$(echo "$REMOVE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")

  if [ "$REMOVE_STATUS" = "removed" ]; then
    log_pass "Worker ${WORKER_ID:0:20}... removed successfully"
  else
    log_fail "Worker removal failed, status='${REMOVE_STATUS}'"
  fi
else
  log_skip "No worker ID available for removal test"
fi

# ============================================================
# Summary
# ============================================================
echo ""
echo -e "${CYAN}======================================${NC}"
echo -e "${CYAN}           Test Summary              ${NC}"
echo -e "${CYAN}======================================${NC}"

for r in "${RESULTS[@]}"; do
  if [[ "$r" == PASS* ]]; then
    echo -e "  ${GREEN}${r}${NC}"
  elif [[ "$r" == FAIL* ]]; then
    echo -e "  ${RED}${r}${NC}"
  elif [[ "$r" == SKIP* ]]; then
    echo -e "  ${YELLOW}${r}${NC}"
  fi
done

TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo ""
echo -e "  Total: ${TOTAL}  ${GREEN}Passed: ${PASS_COUNT}${NC}  ${RED}Failed: ${FAIL_COUNT}${NC}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
