#!/bin/bash
# ============================================================================
# tauri-install.sh - 构建后自动安装到 /Applications 并清理
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
APP_NAME="${APP_NAME:-Agent Neo}"
LEGACY_APP_NAME="${LEGACY_APP_NAME:-Code Agent}"
DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-Install Agent Neo}"
SIGNING_IDENTITY="${SIGNING_IDENTITY:-Code Agent Dev}"
ENTITLEMENTS="$PROJECT_ROOT/src-tauri/Entitlements.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
WEB_PORT="${WEB_PORT:-8180}"

mark_target_unindexed() {
  mkdir -p "$PROJECT_ROOT/src-tauri/target"
  touch "$PROJECT_ROOT/src-tauri/target/.metadata_never_index" 2>/dev/null || true
}

unregister_app_path() {
  local app_path="$1"

  [ -x "$LSREGISTER" ] || return 0
  "$LSREGISTER" -u "$app_path" >/dev/null 2>&1 || true
}

unregister_duplicate_app_entries() {
  [ -x "$LSREGISTER" ] || return 0

  "$LSREGISTER" -dump 2>/dev/null \
    | awk -F'path:[[:space:]]*' '/path:.*(Agent Neo|Code Agent)\.app/ { print $2 }' \
    | sed -E 's/ \([^)]*\)$//' \
    | while IFS= read -r app_path; do
        [ -z "$app_path" ] && continue
        [ "$app_path" = "/Applications/$APP_NAME.app" ] && continue
        unregister_app_path "$app_path"
      done
}

strip_local_secrets() {
  local app_path="$1"
  local resources_root="$app_path/Contents/Resources/_up_"

  [ -d "$resources_root" ] || return 0
  rm -f "$resources_root/.dev-token" "$resources_root/.env" "$resources_root/.env.local"
}

resign_app_if_possible() {
  local app_path="$1"

  # Release 模式自动检测：如果 .app 已经用 "Developer ID Application" 签名（通常还 staple 了
  # notarization ticket），任何重签都会废掉 Developer ID 链 + ticket，导致 spctl reject、
  # Gatekeeper 弹窗。这种情况下必须跳过重签，保留官方签名。
  # Dev 工作流（unsigned / ad-hoc / "Code Agent Dev" 自签）走 else 分支按现行逻辑重签。
  if codesign -dvv "$app_path" 2>&1 | grep -q "Authority=Developer ID Application:"; then
    echo "[tauri-install] detected Developer ID signature on $app_path; skipping re-sign to preserve notarization"
    return 0
  fi

  if security find-identity -v -p codesigning | grep -Fq "\"$SIGNING_IDENTITY\""; then
    codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" "$app_path"
  else
    echo "Warning: signing identity '$SIGNING_IDENTITY' not found; installed app signature not refreshed"
  fi
}

kill_zombie_webserver() {
  # 杀掉可能占用 WEB_PORT 的 zombie webServer.cjs（前次 Tauri main 异常退出残留）。
  # 不清这些 zombie 会导致新 Tauri main 启动时 webServer spawn 检测失败而 abort(SIGABRT)。
  pkill -f "webServer.cjs" 2>/dev/null || true
  local zombies
  zombies=$(lsof -ti :"${WEB_PORT}" 2>/dev/null || true)
  if [ -n "$zombies" ]; then
    echo "[tauri-install] killing zombie processes on port ${WEB_PORT}: $zombies"
    echo "$zombies" | xargs kill -9 2>/dev/null || true
  fi
}

# 关闭正在运行的实例
mark_target_unindexed
pkill -f "$APP_NAME" 2>/dev/null || true
pkill -f "$LEGACY_APP_NAME" 2>/dev/null || true
sleep 1

# 复制到 /Applications（覆盖旧版本）
SOURCE_APP="$BUNDLE_DIR/macos/$APP_NAME.app"
if [ ! -d "$SOURCE_APP" ] && [ -d "$BUNDLE_DIR/macos/$LEGACY_APP_NAME.app" ]; then
  SOURCE_APP="$BUNDLE_DIR/macos/$LEGACY_APP_NAME.app"
fi

if [ -d "$SOURCE_APP" ]; then
  strip_local_secrets "$SOURCE_APP"
  rm -rf "/Applications/$APP_NAME.app"
  cp -R "$SOURCE_APP" "/Applications/$APP_NAME.app"
  strip_local_secrets "/Applications/$APP_NAME.app"
  resign_app_if_possible "/Applications/$APP_NAME.app"
  node "$PROJECT_ROOT/scripts/release-security-scan.mjs" "/Applications/$APP_NAME.app/Contents/Resources/_up_"
  echo "Installed to /Applications/$APP_NAME.app"
  # 强制 Spotlight 重新索引，避免 Launchpad/Spotlight/Raycast 搜不到
  mdimport "/Applications/$APP_NAME.app" 2>/dev/null || true
else
  echo "Error: $BUNDLE_DIR/macos/$APP_NAME.app not found"
  exit 1
fi

# 清理构建产物中的 .app（Spotlight 会索引到导致重复）
unregister_app_path "$SOURCE_APP"
rm -rf "$SOURCE_APP"
rm -rf "$SOURCE_APP.tar.gz"
rm -rf "$PROJECT_ROOT/release/"*"/$APP_NAME.app"

# 弹出所有挂载的 DMG 卷（包括重复构建产生的 "Code Agent 1", "Code Agent 2" 等）
for mounted_name in "$DMG_VOLUME_NAME" "$APP_NAME" "$LEGACY_APP_NAME"; do
  for vol in /Volumes/"$mounted_name"*; do
    [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
  done
done
# 清理 bundle_dmg.sh 残留的临时卷
for vol in /Volumes/dmg.*; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done

unregister_duplicate_app_entries
"$LSREGISTER" -f "/Applications/$APP_NAME.app" >/dev/null 2>&1 || true

# 清掉占着 WEB_PORT 的 zombie webServer（前次 Tauri 异常退出残留），
# 否则新 Tauri main 启动时 webServer spawn 失败会 abort(SIGABRT)。
kill_zombie_webserver

echo "Done. Launch from Spotlight or: open '/Applications/$APP_NAME.app'"
