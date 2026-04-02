#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BASE_URL="${1:?Usage: test-project-locking-sequence.sh <base_url> [timeout_seconds]}"
TIMEOUT="${2:-900}"

REQ1="${SCRIPT_DIR}/requirements/p1-roadmap-studio.md"
REQ2="${SCRIPT_DIR}/requirements/p2-equipment-booking.md"
REQ3="${SCRIPT_DIR}/requirements/p1-roadmap-studio-optimization.md"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; }
log_info() { echo -e "  ${CYAN}INFO${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }

run_case() {
  local requirement_file="$1"
  local summary_file="$2"
  log_info "Running $(basename "$requirement_file")"
  E2E_SUMMARY_FILE="$summary_file" \
    bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "${requirement_file}" "sequence-locking" "${TIMEOUT}"
}

SUMMARY1="${TMP_DIR}/run1.json"
SUMMARY2="${TMP_DIR}/run2.json"
SUMMARY3="${TMP_DIR}/run3.json"

run_case "$REQ1" "$SUMMARY1"
run_case "$REQ2" "$SUMMARY2"
run_case "$REQ3" "$SUMMARY3"

if python3 - "$BASE_URL" "$SUMMARY1" "$SUMMARY2" "$SUMMARY3" <<'PY'
import json
import sys
import urllib.request

base_url, s1_path, s2_path, s3_path = sys.argv[1:]

with open(s1_path, "r", encoding="utf-8") as fh:
    run1 = json.load(fh)
with open(s2_path, "r", encoding="utf-8") as fh:
    run2 = json.load(fh)
with open(s3_path, "r", encoding="utf-8") as fh:
    run3 = json.load(fh)

errors: list[str] = []

project1 = run1.get("projectDir", "")
project2 = run2.get("projectDir", "")
project3 = run3.get("projectDir", "")

if not project1 or not project2 or not project3:
    errors.append(f"Missing projectDir(s): run1={project1!r}, run2={project2!r}, run3={project3!r}")

if project1 and project2 and project1 == project2:
    errors.append(f"Two new products reused the same projectDir unexpectedly: {project1}")

if project1 and project3 and project1 != project3:
    errors.append(f"Optimization did not reuse original projectDir: run1={project1}, run3={project3}")

created3 = set(filter(None, run3.get("createdTaskIds", [])))
session3 = run3.get("sessionKey", "")
started3 = int(run3.get("startedAt", 0) or 0)

with urllib.request.urlopen(f"{base_url.rstrip('/')}/api/v1/tasks", timeout=10) as response:
    tasks_body = json.load(response)

tracked3 = []
for task in tasks_body.get("tasks", []):
    updated_at = int(task.get("updatedAt", 0) or 0)
    if (
        task.get("projectDir", "") == project3
        or task.get("id", "") in created3
        or (task.get("controllerSessionKey", "") == session3 and updated_at >= started3)
    ):
        tracked3.append(task)

if not tracked3:
    errors.append("No tracked tasks found for optimization run")

for task in tracked3:
    task_project = task.get("projectDir", "")
    if task_project and task_project != project3:
        errors.append(f"Optimization task escaped project lock: task={task.get('id')} projectDir={task_project} expected={project3}")

deliverable_paths = []
for task in tracked3:
    contract = task.get("resultContract") if isinstance(task.get("resultContract"), dict) else {}
    deliverables = contract.get("deliverables") if isinstance(contract.get("deliverables"), list) else []
    for deliverable in deliverables:
        if not isinstance(deliverable, dict):
            continue
        value = str(deliverable.get("value", ""))
        if value:
            deliverable_paths.append(value)
            if project2 and f"/{project2}/" in value.replace("\\", "/"):
                errors.append(f"Optimization deliverable points into unrelated projectDir {project2}: {value}")

print(f"run1.projectDir={project1}")
print(f"run2.projectDir={project2}")
print(f"run3.projectDir={project3}")
print(f"run3.trackedTasks={len(tracked3)}")
if deliverable_paths:
    print("run3.deliverables=")
    for value in deliverable_paths:
        print(f"  - {value}")

if errors:
    print("errors=")
    for error in errors:
        print(f"  - {error}")
    sys.exit(1)
PY
then
  log_pass "Project locking sequence passed: new products isolated and optimization reused original projectDir"
else
  log_fail "Project locking sequence failed"
  exit 1
fi
