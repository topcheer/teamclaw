#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCENARIO=""
SKIP_BUILD=false
LIST_ONLY=false
RESULTS=()

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario)
      SCENARIO="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --list)
      LIST_ONLY=true
      shift
      ;;
    --help|-h)
      echo "Usage: bash tests/test-scenario-matrix.sh [--scenario <s2|s3|s4|s6>] [--skip-build] [--list]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

declare -A SCENARIOS=(
  [s2]="S2: Local Dynamic Provision"
  [s3]="S3: Docker External Workers"
  [s4]="S4: Docker Dynamic Provision"
  [s6]="S6: Kubernetes Dynamic Provision"
)

if [ "$LIST_ONLY" = true ]; then
  for s in s2 s3 s4 s6; do
    echo "$s  ${SCENARIOS[$s]}"
  done
  exit 0
fi

if [ -n "$SCENARIO" ]; then
  RUN_LIST=("$SCENARIO")
else
  RUN_LIST=(s2 s3 s4 s6)
fi

echo -e "${BOLD}${CYAN}TeamClaw Test Scenario Matrix${NC}"
for s in "${RUN_LIST[@]}"; do
  echo -e "${BOLD}${SCENARIOS[$s]}${NC}"
  set +e
  case "$s" in
    s2) bash "${SCRIPT_DIR}/test-local-dynamic.sh" ;;
    s3)
      if [ "$SKIP_BUILD" = true ]; then
        bash "${SCRIPT_DIR}/run-tests.sh" --skip-build
      else
        bash "${SCRIPT_DIR}/run-tests.sh"
      fi
      ;;
    s4)
      if [ "$SKIP_BUILD" = true ]; then
        bash "${SCRIPT_DIR}/test-docker-dynamic.sh" --skip-build
      else
        bash "${SCRIPT_DIR}/test-docker-dynamic.sh"
      fi
      ;;
    s6) bash "${SCRIPT_DIR}/test-k8s-dynamic.sh" ;;
  esac
  exit_code=$?
  set -e
  if [ "$exit_code" -eq 0 ]; then
    RESULTS+=("${GREEN}PASS${NC} ${SCENARIOS[$s]}")
  else
    RESULTS+=("${RED}FAIL${NC} ${SCENARIOS[$s]}")
  fi
done

echo ""
for result in "${RESULTS[@]}"; do
  echo -e "$result"
done
