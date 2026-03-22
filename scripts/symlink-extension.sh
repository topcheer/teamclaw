#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# symlink-extension.sh
# ============================================================
# Creates a symlink: openclaw/extensions/teamclaw -> ../../src
# This allows the openclaw workspace to discover teamclaw during
# local development without duplicating files.
#
# Usage:
#   bash scripts/symlink-extension.sh          # create symlink
#   bash scripts/symlink-extension.sh --copy   # physical copy (for Docker)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${PROJECT_ROOT}/openclaw/extensions/teamclaw"
SOURCE="../../src"

if [ "${1:-}" = "--copy" ]; then
  echo "Copying src/ to openclaw/extensions/teamclaw/ (physical copy for Docker)..."
  rm -rf "$TARGET"
  cp -r "${PROJECT_ROOT}/src" "$TARGET"
  echo "Done: physical copy created at ${TARGET}"
else
  echo "Creating symlink: ${TARGET} -> ${SOURCE}"
  rm -rf "$TARGET"
  ln -s "$SOURCE" "$TARGET"
  echo "Done: symlink created"
fi
