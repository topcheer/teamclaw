#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# TeamClaw Test Scenario Matrix Runner
# ============================================================
# Runs all 6 deployment/test scenarios and prints a summary.
# Usage:
#   bash tests/test-scenario-matrix.sh              # run all
#   bash tests/test-scenario-matrix.sh --scenario s1   # run specific scenario
#   bash tests/test-scenario-matrix.sh --scenario s4 --skip-build
#   bash tests/test-scenario-matrix.sh --list          # list available scenarios
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO=""
SKIP_BUILD=false
LIST_ONLY=false
RESULTS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --scenario) SCENARIO="${2:-}"; shift ;;
    --skip-build) SKIP_BUILD=true ;;
    --list) LIST_ONLY=true ;;
    --help|-h)
      echo "Usage: bash tests/test-scenario-matrix.sh [options]"
      echo ""
      echo "Options:"
      echo "  --scenario <s1|s2|s3|s4|s5|s6>  Run a specific scenario"
      echo "  --skip-build                         Skip Docker image build"
      echo "  --list                               List available scenarios"
      echo "  --help                               Show this help"
      exit 0
      ;;
  esac
done

# Scenario definitions
declare -A SCENARIOS
SCENARIOS[s1]="S1: Local Single Process"
SCENARIOS[s2]="S2: Local Dynamic Provision"
SCENARIOS[s3]="S3: Docker Single Container"
SCENARIOS[s4]="S4: Docker Dynamic Provision"
SCENARIOS[s5]="S5: Kubernetes Single Pod"
SCENARIOS[s6]="S6: Kubernetes Dynamic Provision"

SCENARIO_SCRIPTS[s1]="${SCRIPT_DIR}/test-local-single.sh"
SCENARIO_SCRIPTS[s2]="${SCRIPT_DIR}/test-local-dynamic.sh"
SCENARIO_SCRIPTS[s3]="${SCRIPT_DIR}/run-tests.sh --skip-build"
SCENARIO_SCRIPTS[s4]="${SCRIPT_DIR}/test-docker-dynamic.sh"
SCENARIO_SCRIPTS[s5]="${SCRIPT_DIR}/test-k8s-single.sh"
SCENARIO_SCRIPTS[s6]="${SCRIPT_DIR}/test-k8s-dynamic.sh"

SCENARIO_PREREQS[s1]="Node.js"
SCENARIO_PREREQS[s2]="Node.js"
SCENARIO_PREREQS[s3]="Docker"
SCENARIO_PREREQS[s4]="Docker + docker.sock"
SCENARIO_PREREQS[s5]="Kubernetes"
SCENARIO_PREREQS[s6]="Kubernetes + RBAC"

# List mode
if [ "$LIST_ONLY" = true ]; then
  echo -e "${BOLD}${CYAN}TeamClaw Test Scenarios${NC}"
  echo ""
  printf "  %-4s  %-40s  %-20s  %s\n" "ID" "Scenario" "Prerequisites" "Script"
  echo "  ----  ----------------------------------------  --------------------  -----"
  for s in s1 s2 s3 s4 s5 s6; do
    SCRIPT="${SCENARIO_SCRIPTS[$s]}"
    EXISTS="yes"
    [ -f "$SCRIPT" ] || EXISTS="no"
    printf "  %-4s  %-40s  %-20s  %s\n" "$s" "${SCENARIOS[$s]}" "${SCENARIO_PREREQS[$s]}" "$EXISTS"
  done
  exit 0
fi

# Determine which scenarios to run
if [ -n "$SCENARIO" ]; then
  RUN_LIST=("$SCENARIO")
else
  RUN_LIST=(s1 s2 s3 s4 s5 s6)
fi

# Check scripts exist
for s in "${RUN_LIST[@]}"; do
  SCRIPT="${SCENARIO_SCRIPTS[$s]}"
  if [ ! -f "$SCRIPT" ]; then
    echo -e "${RED}ERROR: Script for ${SCENARIOS[$s]} not found: ${SCRIPT}${NC}"
    exit 1
  fi
done

# ----------------------------------------------------------
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║  TeamClaw Test Scenario Matrix               ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Scenarios: ${RUN_LIST[*]}"
echo "  Skip build: ${SKIP_BUILD}"
echo ""

# Run scenarios
for s in "${RUN_LIST[@]}"; do
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  ${SCENARIOS[$s]}${NC}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  SCRIPT="${SCENARIO_SCRIPTS[$s]}"
  ARGS=()
  if [ "$SKIP_BUILD" = true ] && [[ "$s" == s3 || "$s" == s4 ]]; then
    ARGS=(--skip-build)
  fi

  START_TIME=$(date +%s)
  set +e
  if bash "$SCRIPT" "${ARGS[@]}" 2>&1 | tee "/tmp/teamclaw-test-${s}.log"; then
    RESULTS+=("${GREEN}PASS${NC}  ${SCENARIOS[$s]}")
  else
    RESULTS+=("${RED}FAIL${NC}  ${SCENARIOS[$s]}")
  fi
  EXIT_CODE=$?
  set -e
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo ""
  echo -e "  Duration: ${DURATION}s"
  echo ""
done

# Print summary
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Summary${NC}"
echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════${NC}"
for r in "${RESULTS[@]}"; do
  echo -e "  $r"
done

# Check for failures
FAIL_COUNT=0
for r in "${RESULTS[@]}"; do
  if echo "$r" | grep -q "FAIL"; then
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo ""
  echo -e "${BOLD}${RED}${FAIL_COUNT} scenario(s) failed.${NC}"
  exit 1
else
  echo ""
  echo -e "${BOLD}${GREEN}All scenarios passed!${NC}"
fi
