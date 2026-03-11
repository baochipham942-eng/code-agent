#!/bin/bash
# ============================================================================
# tauri-install.sh - 构建后自动安装到 /Applications 并清理
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
APP_NAME="Code Agent"

# 关闭正在运行的实例
pkill -f "$APP_NAME" 2>/dev/null || true
sleep 1

# 复制到 /Applications（覆盖旧版本）
if [ -d "$BUNDLE_DIR/macos/$APP_NAME.app" ]; then
  rm -rf "/Applications/$APP_NAME.app"
  cp -R "$BUNDLE_DIR/macos/$APP_NAME.app" "/Applications/$APP_NAME.app"
  echo "Installed to /Applications/$APP_NAME.app"
else
  echo "Error: $BUNDLE_DIR/macos/$APP_NAME.app not found"
  exit 1
fi

# 清理构建产物中的 .app（Spotlight 会索引到导致重复）
rm -rf "$BUNDLE_DIR/macos/$APP_NAME.app"
rm -rf "$BUNDLE_DIR/macos/$APP_NAME.app.tar.gz"
rm -rf "$PROJECT_ROOT/release/"*"/$APP_NAME.app"

# 弹出所有挂载的 DMG 卷
hdiutil detach "/Volumes/$APP_NAME" 2>/dev/null || true

echo "Done. Launch from Spotlight or: open '/Applications/$APP_NAME.app'"
