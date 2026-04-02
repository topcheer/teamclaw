#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_BUILD=false
SCENARIO=""

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    s2|s3|s4|s6) SCENARIO="$arg" ;;
    all) SCENARIO="all" ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

if [ -z "$SCENARIO" ]; then
  SCENARIO="all"
fi

run_scenario() {
  local id="$1"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BOLD}  Running ${id}${NC}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  case "$id" in
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
}

if [ "$SCENARIO" = "all" ]; then
  for id in s2 s3 s4 s6; do
    run_scenario "$id"
  done
else
  run_scenario "$SCENARIO"
fi
