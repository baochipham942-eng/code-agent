#!/bin/bash
# ============================================================================
# tauri-install.sh - 构建后自动安装到 /Applications 并清理
# ============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BUNDLE_DIR="${BUNDLE_DIR:-$PROJECT_ROOT/src-tauri/target/release/bundle}"
APPLICATIONS_DIR="${APPLICATIONS_DIR:-/Applications}"
APPLICATIONS_DIR="${APPLICATIONS_DIR%/}"
APP_NAME="${APP_NAME:-Agent Neo}"
LEGACY_APP_NAME="${LEGACY_APP_NAME:-Code Agent}"
DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-Install Agent Neo}"
DEFAULT_SIGNING_IDENTITY="Code Agent Dev"
if [ -n "${SIGNING_IDENTITY:-}" ]; then
  SIGNING_IDENTITY_EXPLICIT=1
else
  SIGNING_IDENTITY_EXPLICIT=0
  SIGNING_IDENTITY="$DEFAULT_SIGNING_IDENTITY"
fi
ENTITLEMENTS="$PROJECT_ROOT/src-tauri/Entitlements.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
WEB_PORT="${WEB_PORT:-8180}"
INSTALLED_APP="$APPLICATIONS_DIR/$APP_NAME.app"

is_system_install() {
  [ "$APPLICATIONS_DIR" = "/Applications" ]
}

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
        [ "$app_path" = "$INSTALLED_APP" ] && continue
        unregister_app_path "$app_path"
      done
}

strip_local_secrets() {
  local app_path="$1"
  local resources_root="$app_path/Contents/Resources/_up_"

  [ -d "$resources_root" ] || return 0
  rm -f "$resources_root/.dev-token" "$resources_root/.env" "$resources_root/.env.local"
}

read_developer_id_authority() {
  local app_path="$1"

  [ -d "$app_path" ] || return 0
  codesign -dvv "$app_path" 2>&1 | grep "Authority=Developer ID Application:" | head -n 1 | sed 's/^.*Authority=//'
}

find_codesigning_identity() {
  local wanted="$1"

  security find-identity -v -p codesigning 2>/dev/null | grep -F "\"$wanted\"" | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/'
}

# 不变量：已装实例的 Developer ID 链不能被默认自签盖掉。
# 必须在 rm -rf 旧包之前读已装签名；新拷进来的本地产物永远是自签，不能当锚。
preserve_installed_signing_chain() {
  local installed_app="$1"
  local authority
  local found

  authority="$(read_developer_id_authority "$installed_app")"
  if [ -z "$authority" ]; then
    return 0
  fi

  echo "[tauri-install] 已装实例 ${installed_app} 是 Developer ID 签名（${authority}）"

  case "$SIGNING_IDENTITY" in
    "Developer ID Application:"*)
      echo "[tauri-install] SIGNING_IDENTITY 已是 Developer ID，沿用 $SIGNING_IDENTITY"
      return 0
      ;;
  esac

  if [ "$SIGNING_IDENTITY_EXPLICIT" = "1" ]; then
    echo "Warning: 已装实例是 Developer ID 签名，但 SIGNING_IDENTITY 已显式设为 '$SIGNING_IDENTITY'。将按该身份重签；Developer ID 链、公证 ticket 和 TCC 授权会被替换。"
    return 0
  fi

  found="$(find_codesigning_identity "$authority")"
  if [ -z "$found" ]; then
    echo "Error: ${installed_app} 已用 Developer ID 签名（${authority}），但本机钥匙串找不到这个身份。" >&2
    echo "Error: 若继续用默认自签身份 '$DEFAULT_SIGNING_IDENTITY' 重签，会打断 Developer ID 签名链和公证 ticket，下载文件夹等 TCC 授权也会掉光。" >&2
    echo "Error: 把对应的 Developer ID 证书导入钥匙串后再装，或显式设置 SIGNING_IDENTITY（视为知情，将替换签名链）。" >&2
    exit 1
  fi

  echo "[tauri-install] 将 SIGNING_IDENTITY 切到 '$found'，避免把已装 Developer ID 链盖成自签"
  SIGNING_IDENTITY="$found"
}

resign_app_if_possible() {
  local app_path="$1"

  # 已装实例的签名链由 preserve_installed_signing_chain 在 rm 之前锚定：
  # Developer ID 的已装包会把 SIGNING_IDENTITY 切到对应身份（找不到就 fail-loud；
  # 显式覆盖成自签则警告但不拦）。这里只按当前 SIGNING_IDENTITY 给新拷进来的包重签。
  # 「新包自己已带 Developer ID 签名就保留」的判定在主流程做（NEW_APP_AUTHORITY），
  # 它比 preserve 更靠前：新包无需重签时，不该要求本机具备旧包的签名身份。
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

# 关闭正在运行的实例（只在装到 /Applications 时动本机进程；
# APPLICATIONS_DIR 覆盖用于 /tmp fixture，不能误杀用户正在跑的包）。
mark_target_unindexed
if is_system_install; then
  pkill -f "$APP_NAME" 2>/dev/null || true
  pkill -f "$LEGACY_APP_NAME" 2>/dev/null || true
  sleep 1
fi

# 复制到 APPLICATIONS_DIR（默认 /Applications，覆盖旧版本）
SOURCE_APP="$BUNDLE_DIR/macos/$APP_NAME.app"
if [ ! -d "$SOURCE_APP" ] && [ -d "$BUNDLE_DIR/macos/$LEGACY_APP_NAME.app" ]; then
  SOURCE_APP="$BUNDLE_DIR/macos/$LEGACY_APP_NAME.app"
fi

if [ -d "$SOURCE_APP" ]; then
  strip_local_secrets "$SOURCE_APP"
  NEW_APP_AUTHORITY="$(read_developer_id_authority "$SOURCE_APP")"
  if [ -n "$NEW_APP_AUTHORITY" ]; then
    echo "[tauri-install] 新包已带 Developer ID 签名（${NEW_APP_AUTHORITY}），跳过重签保留官方链"
  else
    preserve_installed_signing_chain "$INSTALLED_APP"
  fi
  rm -rf "$INSTALLED_APP"
  cp -R "$SOURCE_APP" "$INSTALLED_APP"
  strip_local_secrets "$INSTALLED_APP"
  if [ -z "$NEW_APP_AUTHORITY" ]; then
    resign_app_if_possible "$INSTALLED_APP"
  fi
  node "$PROJECT_ROOT/scripts/release-security-scan.mjs" "$INSTALLED_APP/Contents/Resources/_up_"
  echo "Installed to $INSTALLED_APP"
  # 强制 Spotlight 重新索引，避免 Launchpad/Spotlight/Raycast 搜不到
  if is_system_install; then
    mdimport "$INSTALLED_APP" 2>/dev/null || true
  fi
else
  echo "Error: $BUNDLE_DIR/macos/$APP_NAME.app not found"
  exit 1
fi

# 清理构建产物中的 .app（Spotlight 会索引到导致重复）
if is_system_install; then
  unregister_app_path "$SOURCE_APP"
fi
rm -rf "$SOURCE_APP"
rm -rf "$SOURCE_APP.tar.gz"
if is_system_install; then
  rm -rf "$PROJECT_ROOT/release/"*"/$APP_NAME.app"
fi

if is_system_install; then
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
  "$LSREGISTER" -f "$INSTALLED_APP" >/dev/null 2>&1 || true

  # 清掉占着 WEB_PORT 的 zombie webServer（前次 Tauri 异常退出残留），
  # 否则新 Tauri main 启动时 webServer spawn 失败会 abort(SIGABRT)。
  kill_zombie_webserver
fi

echo "Done. Launch from Spotlight or: open '$INSTALLED_APP'"
