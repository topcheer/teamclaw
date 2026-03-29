#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# S6: Kubernetes Dynamic Provision — Controller Pod + kubectl worker Pods
# ============================================================
# Deploys a controller pod that dynamically creates worker pods
# via kubectl. Requires RBAC permissions.
# Usage: bash tests/test-k8s-dynamic.sh
# Prerequisites: kubectl, K8s cluster, Docker image pushed/available
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K8S_DIR="${SCRIPT_DIR}/k8s"
NAMESPACE="teamclaw"
CONTROLLER_POD="teamclaw-controller"
LOCAL_PORT=9528
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

    # Delete managed worker pods
    kubectl delete pods -l "teamclaw.managed=true" -n "$NAMESPACE" --ignore-not-found --grace-period=5 2>/dev/null || true

    # Delete controller pod
    kubectl delete pod "$CONTROLLER_POD" -n "$NAMESPACE" --ignore-not-found --grace-period=5 2>/dev/null || true

    # Delete services
    kubectl delete -f "${K8S_DIR}/services.yaml" -n "$NAMESPACE" --ignore-not-found --grace-period=5 2>/dev/null || true
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
echo "║  S6: Kubernetes Dynamic Provision Test         ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"
echo "  Namespace: ${NAMESPACE}"
echo "  Pod:       ${CONTROLLER_POD}"
echo "  Port:      ${LOCAL_PORT} (local) → 9527 (pod)"
echo ""

# ----------------------------------------------------------
# Step 1: Create namespace, secrets, RBAC
# ----------------------------------------------------------
echo -e "${BOLD}[1/7]${NC} Create K8s resources..."

kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml 2>/dev/null | kubectl apply -f - 2>/dev/null || true

# Secret
if [ -z "${ZAI_API_KEY:-}" ]; then
  echo -e "${RED}ERROR: ZAI_API_KEY environment variable not set.${NC}"
  exit 1
fi
cat "${K8S_DIR}/secret.yaml.template" | ZAI_API_KEY="$ZAI_API_KEY" kubectl apply -n "$NAMESPACE" -f - 2>/dev/null

# Configmaps + RBAC + PVC + Services
kubectl apply -f "${K8S_DIR}/configmaps.yaml" -n "$NAMESPACE" 2>/dev/null
kubectl apply -f "${K8S_DIR}/rbac.yaml" -n "$NAMESPACE" 2>/dev/null
kubectl apply -f "${K8S_DIR}/workspace-pvc.yaml" -n "$NAMESPACE" 2>/dev/null
kubectl apply -f "${K8S_DIR}/services.yaml" -n "$NAMESPACE" 2>/dev/null
log_pass "Namespace, secrets, configmaps, RBAC, PVC, and services created"

# ----------------------------------------------------------
# Step 2: Deploy controller pod
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[2/7]${NC} Deploy controller pod..."

kubectl apply -f "${K8S_DIR}/pods.yaml" --selector=scenario=s6 -n "$NAMESPACE"
log_info "Waiting for controller pod to be ready..."

kubectl wait --for=condition=Ready "pod/${CONTROLLER_POD}" -n "$NAMESPACE" --timeout=120s 2>/dev/null
log_pass "Controller pod is ready"

# ----------------------------------------------------------
# Step 3: Port-forward
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[3/7]${NC} Set up port-forward..."

kubectl port-forward -n "$NAMESPACE" "svc/teamclaw-controller" "${LOCAL_PORT}:9527" > /dev/null 2>&1 &
PORT_FWD_PID=$!
sleep 2

if curl -sf --max-time 3 "${BASE_URL}/api/v1/health" > /dev/null 2>&1; then
  log_pass "Port-forward active, controller accessible"
else
  log_fail "Cannot reach controller"
  exit 1
fi

# ----------------------------------------------------------
# Step 4: Wait for dynamically provisioned worker pods
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[4/7]${NC} Wait for dynamically provisioned worker pods..."

log_info "Waiting up to 90s for k8s worker pods..."
WORKERS_READY=false
for i in $(seq 1 45); do
  STATUS=$(curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null || echo "")
  READY_COUNT=$(echo "$STATUS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
roles = data.get('roles', {})
count = 0
for r in ['developer', 'qa', 'architect']:
    workers = roles.get(r, {}).get('workers', [])
    if workers and workers[0].get('status') in ('ready', 'idle'):
        count += 1
print(count)
" 2>/dev/null || echo "0")

  if [ "$READY_COUNT" -ge 3 ]; then
    WORKERS_READY=true
    log_pass "All 3 k8s workers registered (${READY_COUNT}/3)"
    break
  fi
  sleep 2
done

if [ "$WORKERS_READY" != true ]; then
  log_fail "Only ${READY_COUNT}/3 workers registered after 90s"
  echo ""
  log_info "Worker pods:"
  kubectl get pods -n "$NAMESPACE" -l "teamclaw.managed=true" 2>/dev/null || echo "  (none)"
  echo ""
  log_info "Team status:"
  curl -sf "${BASE_URL}/api/v1/team/status" 2>/dev/null | python3 -m json.tool 2>/dev/null || true
fi

# ----------------------------------------------------------
# Step 5: Verify worker pod topology
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[5/7]${NC} Verify k8s worker pods..."

WORKER_PODS=$(kubectl get pods -n "$NAMESPACE" -l "teamclaw.managed=true" --no-headers 2>/dev/null | wc -l | tr -d ' ')
if [ "$WORKER_PODS" -ge 3 ]; then
  log_pass "Found ${WORKER_PODS} managed worker pods"
else
  log_fail "Expected >= 3 worker pods, found ${WORKER_PODS}"
fi

# Check labels on worker pods
SAMPLE_POD=$(kubectl get pods -n "$NAMESPACE" -l "teamclaw.managed=true" -o jsonpath='{.items[0].metadata.labels}' 2>/dev/null || echo "")
log_info "Worker pod labels: ${SAMPLE_POD}"

# ----------------------------------------------------------
# Step 6: Verify DinD (if docker.sock mounted)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[6/7]${NC} Verify DinD access in worker pods..."

WORKER_POD_NAME=$(kubectl get pods -n "$NAMESPACE" -l "teamclaw.managed=true" -l "teamclaw.role=developer" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [ -n "$WORKER_POD_NAME" ]; then
  # Check if docker.sock is mounted in worker pod spec
  MOUNT_CHECK=$(kubectl get pod "$WORKER_POD_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.volumes[?(@.name=="docker-sock")].name}' 2>/dev/null || echo "")
  if [ -n "$MOUNT_CHECK" ]; then
    log_info "docker.sock volume found in worker pod"
  else
    log_info "No docker.sock in worker pod (DinD not configured)"
  fi
else
  log_info "No developer worker pod for DinD test"
fi

# ----------------------------------------------------------
# Step 7: Run API tests
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[7/8]${NC} Run API test suite..."

if [ -f "${SCRIPT_DIR}/test-api.sh" ]; then
  bash "${SCRIPT_DIR}/test-api.sh" "${BASE_URL}" "distributed"
else
  log_skip "test-api.sh not found"
fi

# ----------------------------------------------------------
# Step 8: Run E2E delivery test (LLM-powered)
# ----------------------------------------------------------
echo ""
echo -e "${BOLD}[8/8]${NC} Run E2E delivery test..."

REQUIREMENT_FILE="${SCRIPT_DIR}/requirements/s6-travel-hotel.md"
if [ -f "${SCRIPT_DIR}/test-e2e-delivery.sh" ] && [ -f "$REQUIREMENT_FILE" ]; then
  bash "${SCRIPT_DIR}/test-e2e-delivery.sh" "${BASE_URL}" "$REQUIREMENT_FILE" "distributed" 900
else
  log_skip "test-e2e-delivery.sh or requirement file not found, skipping E2E delivery test"
fi

# ----------------------------------------------------------
echo ""
echo -e "${BOLD}${GREEN}S6: Kubernetes Dynamic Provision test complete.${NC}"
