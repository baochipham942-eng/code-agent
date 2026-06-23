#!/bin/bash
# ============================================================================
# tauri-install-dev.sh — 安装「测试/开发包」到 /Applications，与生产包并存
# ============================================================================
# 与 tauri-install.sh（生产）的区别：
#   - 只处理 "Agent Neo Dev.app"，绝不 rm / 重签 / 反注册生产 "Agent Neo.app"
#   - 不跑 LaunchServices 全量去重（那会误伤生产包的注册）
#   - 测试包数据走 ~/.code-agent-dev（由 Rust 按 .dev identifier 注入 CODE_AGENT_DATA_DIR）
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="$PROJECT_ROOT/src-tauri/target/release/bundle"
APP_NAME="${APP_NAME:-Agent Neo Dev}"
SIGNING_IDENTITY="${SIGNING_IDENTITY:-Code Agent Dev}"
ENTITLEMENTS="$PROJECT_ROOT/src-tauri/Entitlements.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

strip_local_secrets() {
  local app_path="$1"
  local resources_root="$app_path/Contents/Resources/_up_"
  [ -d "$resources_root" ] || return 0
  rm -f "$resources_root/.dev-token" "$resources_root/.env" "$resources_root/.env.local"
}

resign_app_if_possible() {
  local app_path="$1"
  if security find-identity -v -p codesigning | grep -Fq "\"$SIGNING_IDENTITY\""; then
    codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" "$app_path"
  else
    # 没有自签身份时退回 ad-hoc，保证可启动（TCC 授权可能每次重签后重新询问，测试包可接受）
    echo "[install-dev] signing identity '$SIGNING_IDENTITY' not found; falling back to ad-hoc signature"
    codesign --force --deep --options runtime --entitlements "$ENTITLEMENTS" --sign - "$app_path"
  fi
}

# 只关掉测试包实例，不碰生产
pkill -f "$APP_NAME" 2>/dev/null || true
sleep 1

SOURCE_APP="$BUNDLE_DIR/macos/$APP_NAME.app"
if [ ! -d "$SOURCE_APP" ]; then
  echo "Error: $SOURCE_APP not found（先跑 npm run tauri:package:dev）"
  exit 1
fi

strip_local_secrets "$SOURCE_APP"
rm -rf "/Applications/$APP_NAME.app"
cp -R "$SOURCE_APP" "/Applications/$APP_NAME.app"
strip_local_secrets "/Applications/$APP_NAME.app"
resign_app_if_possible "/Applications/$APP_NAME.app"
node "$PROJECT_ROOT/scripts/release-security-scan.mjs" "/Applications/$APP_NAME.app/Contents/Resources/_up_"
echo "Installed to /Applications/$APP_NAME.app"
mdimport "/Applications/$APP_NAME.app" 2>/dev/null || true

# 清理构建产物里的 .app（避免 Spotlight 索引到重复），仅清测试包，弹出测试包 DMG 卷
unregister_dev() { [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$SOURCE_APP" >/dev/null 2>&1 || true; }
unregister_dev
rm -rf "$SOURCE_APP" "$SOURCE_APP.tar.gz"
for vol in /Volumes/"$APP_NAME"*; do
  [ -d "$vol" ] && hdiutil detach "$vol" 2>/dev/null || true
done
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "/Applications/$APP_NAME.app" >/dev/null 2>&1 || true

echo "Done. 测试包独立运行（数据目录 ~/.code-agent-dev）：open '/Applications/$APP_NAME.app'"
