#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

IMAGE_REF="${IMAGE_REF:-${1:-}}"
if [[ -z "${IMAGE_REF}" ]]; then
  echo "Usage: IMAGE_REF=registry.example.com/teamclaw/teamclaw-openclaw:tag $0" >&2
  echo "   or: $0 registry.example.com/teamclaw/teamclaw-openclaw:tag" >&2
  exit 1
fi

PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH_MODE="${PUSH_MODE:-push}"
OPENCLAW_EXTENSIONS="${OPENCLAW_EXTENSIONS:-teamclaw}"

if [[ "${PUSH_MODE}" != "push" && "${PUSH_MODE}" != "load" ]]; then
  echo "PUSH_MODE must be 'push' or 'load'" >&2
  exit 1
fi

if [[ "${PUSH_MODE}" == "load" && "${PLATFORMS}" == *","* ]]; then
  echo "PUSH_MODE=load only supports a single platform. Current PLATFORMS=${PLATFORMS}" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/teamclaw-runtime-image.XXXXXX")"
trap 'rm -rf "${TMP_DIR}"' EXIT

CONTEXT_JSON="${TMP_DIR}/context.json"
node "${REPO_ROOT}/scripts/prepare-teamclaw-runtime-context.mjs" \
  --output-dir "${TMP_DIR}/build" > "${CONTEXT_JSON}"

CONTEXT_DIR="$(node -e 'const fs=require("node:fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(o.contextDir)' "${CONTEXT_JSON}")"
DOCKERFILE_PATH="$(node -e 'const fs=require("node:fs"); const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(o.dockerfilePath)' "${CONTEXT_JSON}")"

CMD=(
  docker buildx build
  --platform "${PLATFORMS}"
  --file "${DOCKERFILE_PATH}"
  --build-arg "OPENCLAW_EXTENSIONS=${OPENCLAW_EXTENSIONS}"
  --tag "${IMAGE_REF}"
)

if [[ "${PUSH_MODE}" == "push" ]]; then
  CMD+=(--push)
else
  CMD+=(--load)
fi

CMD+=("${CONTEXT_DIR}")

echo "Building TeamClaw runtime image"
echo "  image:      ${IMAGE_REF}"
echo "  platforms:  ${PLATFORMS}"
echo "  mode:       ${PUSH_MODE}"
echo "  context:    ${CONTEXT_DIR}"
echo "  dockerfile: ${DOCKERFILE_PATH}"

"${CMD[@]}"
