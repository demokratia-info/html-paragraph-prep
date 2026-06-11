#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK_FILE="${TMPDIR:-/tmp}/summary-html-desk-codex.lock"

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[$(date -Is)] Previous processing run is still active."
    exit 0
  fi
fi

cd "$ROOT_DIR"
node scripts/process_pending_with_codex.mjs
