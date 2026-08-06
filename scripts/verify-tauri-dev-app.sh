#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
APP_PATH="${1:-/Applications/Agent Neo Dev.app}"

# shellcheck source=lib/tauri-app-resources.sh
source "$SCRIPT_DIR/lib/tauri-app-resources.sh"

RESOURCES_ROOT="$(resolve_tauri_app_resources_root "$APP_PATH")"
node "$PROJECT_ROOT/scripts/tauri-resource-inventory.mjs" --root "$RESOURCES_ROOT"
node "$PROJECT_ROOT/scripts/desktop-shell-packaged-smoke.mjs" \
  --app "$APP_PATH" \
  --port "${DEV_APP_WEB_PORT:-8181}" \
  --app-port "${DEV_APP_WEB_PORT:-8181}" \
  --health-only \
  --timeout-ms "${DEV_SMOKE_TIMEOUT_MS:-120000}"
