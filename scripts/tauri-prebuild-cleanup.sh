#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
APP_NAME="Code Agent"

if [ -d "$BUNDLE_DIR" ]; then
  find "$BUNDLE_DIR" -type f -name 'rw.*.dmg' -delete 2>/dev/null || true
fi

for vol in /Volumes/"$APP_NAME"* /Volumes/dmg.*; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done
