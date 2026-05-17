#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
APP_NAME="${APP_NAME:-Agent Neo}"
LEGACY_APP_NAME="${LEGACY_APP_NAME:-Code Agent}"

if [ -d "$BUNDLE_DIR" ]; then
  find "$BUNDLE_DIR" -type f -name 'rw.*.dmg' -delete 2>/dev/null || true
fi

for mounted_name in "$APP_NAME" "$LEGACY_APP_NAME"; do
  for vol in /Volumes/"$mounted_name"*; do
    [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
  done
done

for vol in /Volumes/dmg.*; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done
