#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# TeamClaw Plugin API Tests
# ============================================================
# Executes 18 test scenarios against a running Controller.
# Usage: bash test-api.sh [BASE_URL] [TOPOLOGY]
#   BASE_URL defaults to http://localhost:9527
#   TOPOLOGY defaults to distributed
# ============================================================

BASE_URL="${1:-http://localhost:9527}"
TOPOLOGY="${2:-distributed}"
PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()
WORKER_ID=""

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
echo -e "  Topology: ${TOPOLOGY}"
echo ""

# ----------------------------------------------------------
# Test 1: Controller Health Check
# ----------------------------------------------------------
echo -e "${CYAN}[1/18]${NC} Controller health check"

if wait_for_health 30 2; then
  BODY=$(curl -sf "${BASE_URL}/api/v1/health")
  MODE=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('mode',''))" 2>/dev/null || echo "")
  if [ "$MODE" = "controller" ]; then
    log_pass "Controller is healthy, mode=controller"
    ROOT_HEADERS=$(curl -s -o /dev/null -D - "${BASE_URL}/" 2>/dev/null || true)
    ROOT_STATUS=$(printf '%s' "$ROOT_HEADERS" | awk 'NR==1 {print $2}')
    ROOT_LOCATION=$(printf '%s' "$ROOT_HEADERS" | awk 'tolower($1)=="location:" {gsub("\r","",$2); print $2}')
    if [[ "$ROOT_STATUS" =~ ^30[1278]$ || "$ROOT_STATUS" = "303" ]]; then
      if [ "$ROOT_LOCATION" = "/ui" ]; then
        log_pass "Root path redirects to /ui"
      else
        log_fail "Root redirect target was '${ROOT_LOCATION}', expected '/ui'"
      fi
    else
      log_fail "Root path did not redirect, status='${ROOT_STATUS}'"
    fi
  else
    log_fail "Controller responded but mode='${MODE}', expected 'controller'"
  fi
else
  log_fail "Controller did not become healthy within timeout"
fi

# ----------------------------------------------------------
# Test 2: Git collaboration bootstrap
# ----------------------------------------------------------
echo -e "${CYAN}[2/18]${NC} Git collaboration bootstrap"

REPO_BODY=$(curl -sf "${BASE_URL}/api/v1/repo" 2>/dev/null || echo "{}")
REPO_ENABLED=$(echo "$REPO_BODY" | python3 -c "import sys,json; print('true' if json.load(sys.stdin).get('repo',{}).get('enabled') else 'false')" 2>/dev/null || echo "false")
REPO_BRANCH=$(echo "$REPO_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('repo',{}).get('defaultBranch',''))" 2>/dev/null || echo "")

if [ "$REPO_ENABLED" = "true" ] && [ -n "$REPO_BRANCH" ]; then
  if [ "$TOPOLOGY" = "distributed" ]; then
    BUNDLE_BYTES=$(curl -sf "${BASE_URL}/api/v1/repo/bundle" 2>/dev/null | wc -c | tr -d ' ')
    if [ "${BUNDLE_BYTES:-0}" -gt 0 ]; then
      log_pass "Git repo ready on branch=${REPO_BRANCH}, bundle export size=${BUNDLE_BYTES} bytes"
    else
      log_fail "Git repo reported ready but bundle export was empty"
    fi
  else
    log_pass "Git repo ready on branch=${REPO_BRANCH}"
  fi
else
  log_fail "Git repo bootstrap missing or invalid"
fi

# ----------------------------------------------------------
# Test 3: Worker Registration (wait for 3 workers)
# ----------------------------------------------------------
echo -e "${CYAN}[3/18]${NC} Worker registration (waiting for 3 workers)"

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
# Test 4: Create Task + Auto-assign
# ----------------------------------------------------------
echo -e "${CYAN}[4/18]${NC} Create task with auto-assignment"

TASK_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement user login feature",
    "description": "Add login/logout functionality with JWT tokens",
    "priority": "high",
    "assignedRole": "developer",
    "recommendedSkills": ["find-skills"],
    "createdBy": "test-runner"
  }' 2>/dev/null || echo "{}")

TASK_STATUS=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")
TASK_ID=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")
TASK_SKILL_COUNT=$(echo "$TASK_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('task',{}).get('recommendedSkills',[])))" 2>/dev/null || echo "0")

if [ -n "$TASK_ID" ] && [ "$TASK_STATUS" = "assigned" ] && [ "$TASK_SKILL_COUNT" -ge 1 ]; then
  log_pass "Task created with recommended skills and auto-assigned, status=${TASK_STATUS}, id=${TASK_ID:0:20}..."
else
  log_fail "Task creation issue: status='${TASK_STATUS}', id='${TASK_ID}', recommendedSkills=${TASK_SKILL_COUNT}"
  # Not a hard failure if no developer worker matched - task is still created
  if [ -n "$TASK_ID" ]; then
    log_info "Task was created (id=${TASK_ID:0:20}...) but not auto-assigned"
  fi
fi

# ----------------------------------------------------------
# Test 5: Get Task List
# ----------------------------------------------------------
echo -e "${CYAN}[5/18]${NC} Get task list"

TASKS_BODY=$(curl -sf "${BASE_URL}/api/v1/tasks" 2>/dev/null || echo "{}")
TASKS_COUNT=$(echo "$TASKS_BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('tasks',[])))" 2>/dev/null || echo "0")
TASK_LIST_HAS_SKILLS=$(echo "$TASKS_BODY" | python3 -c "import sys,json; data=json.load(sys.stdin); task_id='${TASK_ID}'; print('yes' if any(t.get('id') == task_id and len(t.get('recommendedSkills',[])) >= 1 for t in data.get('tasks',[])) else 'no')" 2>/dev/null || echo "no")

if [ "$TASKS_COUNT" -ge 1 ] && [ "$TASK_LIST_HAS_SKILLS" = "yes" ]; then
  log_pass "Task list returned ${TASKS_COUNT} task(s) and preserves recommended skills"
else
  log_fail "Task list returned ${TASKS_COUNT} tasks, recommendedSkills preserved=${TASK_LIST_HAS_SKILLS}"
fi

# ----------------------------------------------------------
# Test 6: Direct Message Routing
# ----------------------------------------------------------
echo -e "${CYAN}[6/18]${NC} Direct message routing"

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
# Test 7: Broadcast Message
# ----------------------------------------------------------
echo -e "${CYAN}[7/18]${NC} Broadcast message"

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
# Test 8: Review Request
# ----------------------------------------------------------
echo -e "${CYAN}[8/18]${NC} Review request message"

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
# Test 9: Task Handoff
# ----------------------------------------------------------
echo -e "${CYAN}[9/18]${NC} Task handoff"

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
# Test 10: Task Result Submission
# ----------------------------------------------------------
echo -e "${CYAN}[10/18]${NC} Task result submission"

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
# Test 11: Task execution detail
# ----------------------------------------------------------
echo -e "${CYAN}[11/18]${NC} Task execution detail"

if [ -n "$TASK_ID" ]; then
  EXECUTION_RESPONSE=$(curl -sf "${BASE_URL}/api/v1/tasks/${TASK_ID}/execution" 2>/dev/null || echo "{}")
  EXECUTION_TASK_ID=$(echo "$EXECUTION_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")
  EXECUTION_EVENT_COUNT=$(echo "$EXECUTION_RESPONSE" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('task',{}).get('execution',{}).get('events',[])))" 2>/dev/null || echo "0")
  EXECUTION_HAS_MESSAGES=$(echo "$EXECUTION_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'messages' in d else 'no')" 2>/dev/null || echo "no")
  EXECUTION_HAS_CLARIFICATIONS=$(echo "$EXECUTION_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'clarifications' in d else 'no')" 2>/dev/null || echo "no")
  EXECUTION_HAS_SKILL_EVENT=$(echo "$EXECUTION_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if any(e.get('phase') == 'skills_recommended' for e in d.get('task',{}).get('execution',{}).get('events',[])) else 'no')" 2>/dev/null || echo "no")

  if [ "$EXECUTION_TASK_ID" = "$TASK_ID" ] && [ "$EXECUTION_EVENT_COUNT" -ge 1 ] && \
     [ "$EXECUTION_HAS_MESSAGES" = "yes" ] && [ "$EXECUTION_HAS_CLARIFICATIONS" = "yes" ] && \
     [ "$EXECUTION_HAS_SKILL_EVENT" = "yes" ]; then
    log_pass "Task execution detail returned ${EXECUTION_EVENT_COUNT} event(s) with related history and skill guidance"
  else
    log_fail "Task execution detail incomplete: task='${EXECUTION_TASK_ID}', events=${EXECUTION_EVENT_COUNT}, messages=${EXECUTION_HAS_MESSAGES}, clarifications=${EXECUTION_HAS_CLARIFICATIONS}, skillEvent=${EXECUTION_HAS_SKILL_EVENT}"
  fi
else
  log_skip "No task ID available for execution detail test"
fi

# ----------------------------------------------------------
# Test 12: Final result after premature completion status
# ----------------------------------------------------------
echo -e "${CYAN}[12/18]${NC} Final result accepted after premature completed status"

RACE_TASK_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Verify premature completion handling",
    "description": "Produce a short implementation note for a login workflow.",
    "priority": "medium",
    "assignedRole": "developer",
    "createdBy": "race-test"
  }' 2>/dev/null || echo "{}")

RACE_TASK_ID=$(echo "$RACE_TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")
RACE_WORKER_ID=$(echo "$RACE_TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('assignedWorkerId',''))" 2>/dev/null || echo "")

if [ -n "$RACE_TASK_ID" ] && [ -n "$RACE_WORKER_ID" ]; then
  curl -sf -X PATCH "${BASE_URL}/api/v1/tasks/${RACE_TASK_ID}" \
    -H "Content-Type: application/json" \
    -d '{
      "status": "completed",
      "progress": "Worker reported completion too early during the run."
    }' > /dev/null 2>&1 || true

  RACE_RESULT_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks/${RACE_TASK_ID}/result" \
    -H "Content-Type: application/json" \
    -d "{
      \"result\": \"Final deliverable arrived after the premature completion flag.\",
      \"workerId\": \"${RACE_WORKER_ID}\"
    }" 2>/dev/null || echo "{}")

  RACE_RESULT_STATUS=$(echo "$RACE_RESULT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")
  RACE_COMPLETED_AT=$(echo "$RACE_RESULT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('completedAt',''))" 2>/dev/null || echo "")
  RACE_RESULT_TEXT=$(echo "$RACE_RESULT_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('result',''))" 2>/dev/null || echo "")

  if [ "$RACE_RESULT_STATUS" = "completed" ] && [ -n "$RACE_COMPLETED_AT" ] && \
     [ "$RACE_RESULT_TEXT" = "Final deliverable arrived after the premature completion flag." ]; then
    log_pass "Controller accepted the final result even after an early completed status"
  else
    log_fail "Premature completion handling failed: status='${RACE_RESULT_STATUS}', completedAt='${RACE_COMPLETED_AT}', result='${RACE_RESULT_TEXT}'"
  fi
else
  log_skip "Could not create an auto-assigned task for premature completion handling"
fi

# ----------------------------------------------------------
# Test 12: Worker Heartbeat Timeout
# ----------------------------------------------------------
echo -e "${CYAN}[13/18]${NC} Worker heartbeat timeout detection"

if [ "$TOPOLOGY" = "single-instance" ]; then
  log_skip "Single-instance mode uses controller-managed local workers; heartbeat timeout test skipped"
elif [ "$WORKER_COUNT" -gt 0 ]; then
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
# Test 13: Roles List
# ----------------------------------------------------------
echo -e "${CYAN}[14/18]${NC} Roles list"

ROLES_BODY=$(curl -sf "${BASE_URL}/api/v1/roles" 2>/dev/null || echo "{}")
ROLES_COUNT=$(echo "$ROLES_BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('roles',[])))" 2>/dev/null || echo "0")

if [ "$ROLES_COUNT" -eq 10 ]; then
  log_pass "Roles list returned ${ROLES_COUNT} roles"
  echo "$ROLES_BODY" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for r in data.get('roles', []):
    print(f'    - {r[\"id\"]:20s} {r[\"label\"]}')
" 2>/dev/null || true
else
  log_fail "Roles list returned ${ROLES_COUNT} roles, expected 10"
fi

# ----------------------------------------------------------
# Test 14: Team Status
# ----------------------------------------------------------
echo -e "${CYAN}[15/18]${NC} Team status"

CONTROLLER_INTAKE_RESPONSE=$(curl -sf --max-time 120 -X POST "${BASE_URL}/api/v1/controller/intake" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionKey": "test-api-controller-run",
    "message": "Controller run smoke: briefly summarize current team state and avoid creating future-only tasks unless they are immediately executable."
  }' 2>/dev/null || echo "{}")
CONTROLLER_RUN_ID=$(echo "$CONTROLLER_INTAKE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('controllerRunId',''))" 2>/dev/null || echo "")
CONTROLLER_REPLY=$(echo "$CONTROLLER_INTAKE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null || echo "")
CONTROLLER_RUNS_BODY=$(curl -sf "${BASE_URL}/api/v1/controller/runs" 2>/dev/null || echo "{}")
STATUS_BODY=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "{}")
TEAM_NAME=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('teamName',''))" 2>/dev/null || echo "")
HAS_WORKERS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'workers' in d else 'no')" 2>/dev/null || echo "no")
HAS_TASKS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'tasks' in d else 'no')" 2>/dev/null || echo "no")
HAS_CONTROLLER_RUNS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'controllerRuns' in d else 'no')" 2>/dev/null || echo "no")
STATUS_CONTROLLER_RUN_COUNT=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('controllerRuns',[])))" 2>/dev/null || echo "0")
CONTROLLER_RUN_FOUND=$(echo "$CONTROLLER_RUNS_BODY" | python3 -c "import sys,json; data=json.load(sys.stdin); run_id='${CONTROLLER_RUN_ID}'; print('yes' if run_id and any(run.get('id') == run_id for run in data.get('controllerRuns',[])) else 'no')" 2>/dev/null || echo "no")

if [ -n "$TEAM_NAME" ] && [ "$HAS_WORKERS" = "yes" ] && [ "$HAS_TASKS" = "yes" ] && \
   [ "$HAS_CONTROLLER_RUNS" = "yes" ] && [ -n "$CONTROLLER_RUN_ID" ] && [ -n "$CONTROLLER_REPLY" ] && \
   [ "$CONTROLLER_RUN_FOUND" = "yes" ] && [ "$STATUS_CONTROLLER_RUN_COUNT" -ge 1 ]; then
  STATUS_WORKERS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('workerCount',0))" 2>/dev/null || echo "0")
  STATUS_TASKS=$(echo "$STATUS_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('taskCount',0))" 2>/dev/null || echo "0")
  log_pass "Team status: name=${TEAM_NAME}, workers=${STATUS_WORKERS}, tasks=${STATUS_TASKS}, controllerRuns=${STATUS_CONTROLLER_RUN_COUNT}"
else
  log_fail "Team status incomplete: name='${TEAM_NAME}', workers=${HAS_WORKERS}, tasks=${HAS_TASKS}, controllerRuns=${HAS_CONTROLLER_RUNS}, runId='${CONTROLLER_RUN_ID}', runFound=${CONTROLLER_RUN_FOUND}"
fi

# ----------------------------------------------------------
# Test 15: Clarification Workflow
# ----------------------------------------------------------
echo -e "${CYAN}[16/18]${NC} Clarification workflow"

CLAR_TASK_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/tasks" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Need clarification on auth strategy",
    "description": "Pause implementation until the human confirms whether the MVP should use session cookies or JWT bearer tokens.",
    "priority": "high",
    "assignedRole": "developer",
    "createdBy": "clarification-test"
  }' 2>/dev/null || echo "{}")

CLAR_TASK_ID=$(echo "$CLAR_TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('id',''))" 2>/dev/null || echo "")
CLAR_TASK_WORKER_ID=$(echo "$CLAR_TASK_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('worker',{}).get('id',''))" 2>/dev/null || echo "")

if [ -n "$CLAR_TASK_ID" ]; then
  CLAR_REQUEST_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/clarifications" \
    -H "Content-Type: application/json" \
    -d "{
      \"taskId\": \"${CLAR_TASK_ID}\",
      \"requestedBy\": \"${CLAR_TASK_WORKER_ID}\",
      \"requestedByWorkerId\": \"${CLAR_TASK_WORKER_ID}\",
      \"requestedByRole\": \"developer\",
      \"question\": \"Should the MVP browser login use session cookies or JWT bearer tokens?\",
      \"blockingReason\": \"The answer changes middleware, storage, and QA coverage.\",
      \"context\": \"Please pick one clear MVP auth mechanism.\"
    }" 2>/dev/null || echo "{}")

  CLAR_REQUEST_ID=$(echo "$CLAR_REQUEST_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('clarification',{}).get('id',''))" 2>/dev/null || echo "")
  CLAR_TASK_STATUS=$(echo "$CLAR_REQUEST_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")
  CLAR_PENDING_COUNT=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('pendingClarificationCount',-1))" 2>/dev/null || echo "-1")

  if [ -n "$CLAR_REQUEST_ID" ] && [ "$CLAR_TASK_STATUS" = "blocked" ] && [ "$CLAR_PENDING_COUNT" -ge 1 ]; then
    CLAR_ANSWER_RESPONSE=$(curl -sf -X POST "${BASE_URL}/api/v1/clarifications/${CLAR_REQUEST_ID}/answer" \
      -H "Content-Type: application/json" \
      -d '{
        "answer": "Use secure HTTP-only session cookies for the browser MVP.",
        "answeredBy": "test-human"
      }' 2>/dev/null || echo "{}")

    CLAR_ANSWER_STATUS=$(echo "$CLAR_ANSWER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('clarification',{}).get('status',''))" 2>/dev/null || echo "")
    CLAR_RESUMED_STATUS=$(echo "$CLAR_ANSWER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('task',{}).get('status',''))" 2>/dev/null || echo "")
    CLAR_PENDING_AFTER=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('pendingClarificationCount',-1))" 2>/dev/null || echo "-1")

    if [ "$CLAR_ANSWER_STATUS" = "answered" ] && \
       { [ "$CLAR_RESUMED_STATUS" = "assigned" ] || [ "$CLAR_RESUMED_STATUS" = "pending" ] || [ "$CLAR_RESUMED_STATUS" = "in_progress" ]; } && \
       [ "$CLAR_PENDING_AFTER" -eq 0 ]; then
      log_pass "Clarification loop works: blocked -> answered -> ${CLAR_RESUMED_STATUS}"
    else
      log_fail "Clarification answer unexpected: status='${CLAR_ANSWER_STATUS}', task='${CLAR_RESUMED_STATUS}', pending=${CLAR_PENDING_AFTER}"
    fi
  else
    log_fail "Clarification request unexpected: id='${CLAR_REQUEST_ID}', task='${CLAR_TASK_STATUS}', pending=${CLAR_PENDING_COUNT}"
  fi
else
  log_fail "Clarification workflow could not create test task"
fi

# ----------------------------------------------------------
# Test 16: Web UI Accessible
# ----------------------------------------------------------
echo -e "${CYAN}[17/18]${NC} Web UI accessible"

UI_HTML=$(curl -sf "${BASE_URL}/ui" 2>/dev/null || echo "")
UI_HTTP_CODE=$(curl -sf -o /dev/null -w "%{http_code}" "${BASE_URL}/ui" 2>/dev/null || echo "000")
UI_APP_JS=$(curl -sf "${BASE_URL}/ui/app.js" 2>/dev/null || echo "")
UI_STYLE_CSS=$(curl -sf "${BASE_URL}/ui/style.css" 2>/dev/null || echo "")

if [ "$UI_HTTP_CODE" = "200" ] && \
   echo "$UI_HTML" | grep -q 'id="controller-runs"' && \
   echo "$UI_HTML" | grep -q 'id="task-recommended-skills"' && \
   echo "$UI_HTML" | grep -q 'data-tab="clarifications"' && \
   echo "$UI_HTML" | grep -q 'id="task-detail-modal"' && \
   echo "$UI_HTML" | grep -q 'data-task-detail-tab="timeline"' && \
   echo "$UI_APP_JS" | grep -q 'renderControllerRuns' && \
   echo "$UI_APP_JS" | grep -q 'controller:run' && \
   echo "$UI_APP_JS" | grep -q 'message-content markdown-body' && \
   echo "$UI_APP_JS" | grep -q 'task-output-body markdown-body' && \
   echo "$UI_STYLE_CSS" | grep -Fq '.markdown-body' && \
   echo "$UI_STYLE_CSS" | grep -Fq '.controller-run-card' && \
   echo "$UI_STYLE_CSS" | grep -Fq '.skill-pill'; then
  log_pass "Web UI returned HTTP 200 and includes task detail, controller activity, skills, and markdown rendering hooks"
else
  log_fail "Web UI returned HTTP ${UI_HTTP_CODE} or missing task detail / controller activity / markdown UI hooks"
fi

# ----------------------------------------------------------
# Test 17: Worker Removal
# ----------------------------------------------------------
echo -e "${CYAN}[18/18]${NC} Worker removal"

if [ "$TOPOLOGY" = "single-instance" ]; then
  log_skip "Single-instance mode uses controller-managed local workers; removal test skipped"
elif [ -n "$WORKER_ID" ]; then
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
