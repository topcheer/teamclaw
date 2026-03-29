#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# S5: Kubernetes Single Pod — Controller + localRoles
# ============================================================
# Deploys a single pod with controller + localRoles.
# Usage: bash tests/test-k8s-single.sh
# Prerequisites: kubectl, K8s cluster, Docker image pushed/available
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="${SCRIPT_DIR}/k8s"
NAMESPACE="teamclaw"
POD_NAME="teamclaw"
LOCAL_PORT=9527
BASE_URL="http://localhost:${LOCAL_PORT}"
PORT_FWD_PID=""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
log_fail() { echo -e "  ${RED}FAIL${NC} $1"; }
log_info() { echo -e "  ${CYAN}INFO${NC} $1"; }

cleanup() {
  local exit_code=$?
  if [ -n "$PORT_FWD_PID" ]; then
    kill "$PORT_FWD_PID" 2>/dev/null || true
    wait "$PORT_FWD_PID" 2>/dev/null || true
  fi
  if [ "${1:-false}" != "keep" ]; then
    log_info "Cleaning up K8s resources..."
    kubectl delete -f "${K8S_DIR}/pods.yaml" --selector=scenario=s5 -n "$NAMESPACE" --ignore-not-found 2>/dev/null || true
    kubectl delete pod "$POD_NAME" -n "$NAMESPACE" --ignore-not-found --grace-period=5 2>/dev/null || true
  fi
  exit $exit_code
}

trap cleanup EXIT

# Pre-flight
if ! command -v kubectl &>/dev/null; then
  echo -e "${RED}ERROR: kubectl not found.${NC}"
  exit 1
fi

# ----------------------------------------------------------
echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║  S5: Kubernetes Single Pod Test               ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Namespace: ${NAMESPACE}"
echo "  Pod:       ${POD_NAME}"
echo "  Port:      ${LOCAL_PORT} (local) → 9527 (pod)"
echo ""

# ----------------------------------------------------------
# Step 1: Create namespace and secrets
# ----------------------------------------------------------
echo -e "${BOLD}[1/6]${NC} Create namespace and resources..."

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml 2>/dev/null | kubectl apply -f - 2>/dev/null || true

# Create secret (requires ZAI_API_KEY)
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo -e "${RED}ERROR: ZAI_API_KEY environment variable not set.${NC}"
  exit 1
fi
cat "${K8S_DIR}/secret.yaml.template" | ZAI_API_KEY="$ZAI_API_KEY" kubectl apply -n "$NAMESPACE" -f - 2>/dev/null

# Create configmaps
kubectl apply -f "${K8S_DIR}/configmaps.yaml" -n "$NAMESPACE" 2>/dev/null
log_pass "Namespace, secrets, and configmaps created"

# ----------------------------------------------------------
# Step 2: Deploy pod
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[2/6]${NC} Deploy teamclaw pod..."

kubectl apply -f "${K8S_DIR}/pods.yaml" --selector=scenario=s5 -n "$NAMESPACE"
log_info "Waiting for pod to start..."

kubectl wait --for=condition=Ready "pod/${POD_NAME}" -n "$NAMESPACE" --timeout=120s 2>/dev/null
log_pass "Pod is ready"

# ----------------------------------------------------------
# Step 3: Port-forward
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[3/6]${NC} Set up port-forward..."

kubectl port-forward -n "$NAMESPACE" "pod/${POD_NAME}" "${LOCAL_PORT}:9527" > /dev/null 2>&1 &
PORT_FWD_PID=$!
sleep 2

if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
  log_pass "Port-forward active, controller accessible"
else
  log_fail "Cannot reach controller via port-forward"
  exit 1
fi

# ----------------------------------------------------------
# Step 4: Verify localRoles
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[4/6]${NC} Verify local roles..."

STATUS=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "")
echo "$STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
roles = data.get('roles', {})
for r in ['developer', 'qa', 'architect']:
    workers = roles.get(r, {}).get('workers', [])
    count = len(workers)
    status = workers[0].get('status', 'none') if workers else 'none'
    print(f'  Role {r}: {count} worker(s), status={status}')
" 2>/dev/null || log_info "Could not parse team status"

LOCAL_READY=$(echo "$STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
roles = data.get('roles', {})
for r in ['developer', 'qa', 'architect']:
    workers = roles.get(r, {}).get('workers', [])
    if not (workers and workers[0].get('status') in ('ready', 'idle')):
        print('NOT_READY'); sys.exit(0)
print('ALL_READY')
" 2>/dev/null || echo "PARSE_ERROR")

if [ "$LOCAL_READY" = "ALL_READY" ]; then
  log_pass "All 3 local roles ready in single pod"
else
  log_fail "Not all roles ready (${LOCAL_READY})"
fi

# ----------------------------------------------------------
# Step 5: Verify workspace in pod
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[5/6]${NC} Verify workspace in pod..."

WS_TEST=$(kubectl exec -n "$NAMESPACE" "$POD_NAME" -- sh -c "mkdir -p /home/node/.openclaw/workspace && echo OK" 2>/dev/null || echo "FAIL")
if [ "$WS_TEST" = "OK" ]; then
  log_pass "Workspace directory writable inside pod"
else
  log_fail "Workspace not writable inside pod"
fi

# ----------------------------------------------------------
# Step 6: Run API tests
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[6/7]${NC} Run API test suite..."

if [ -f "${SCRIPT_DIR}/test-api.sh" ]; then
  bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "single-instance"
else
  log_skip "test-api.sh not found"
fi

# ----------------------------------------------------------
# Step 7: Run E2E delivery test (LLM-powered)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[7/7]${NC} Run E2E delivery test..."

REQUIREMENT_FILE="${SCRIPT_DIR}/requirements/s5-ecommerce-shop.md"
if [ -f "${SCRIPT_DIR}/test-e2e-delivery.sh" ] && [ -f "$REQUIREMENT_FILE" ]; then
  bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "$REQUIREMENT_FILE" "single-instance" 900
else
  log_skip "test-e2e-delivery.sh or requirement file not found, skipping E2E delivery test"
fi

# ----------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}S5: Kubernetes Single Pod test complete.${NC}"
