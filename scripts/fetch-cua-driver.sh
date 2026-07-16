#!/usr/bin/env bash
# ============================================================================
# 重签名 cua-driver (trycua, MIT) → staged "Agent Neo Computer Use.app"
# ============================================================================
# 上游: https://github.com/trycua/cua (libs/cua-driver, MIT)
# 用途: Neo 的 computer-use 新底座（AX 树优先 + 后台不抢焦点），stdio MCP 接入。
# 触发时机: 首次 clone 后、需要升级 CUA_DRIVER_VERSION 时（同 fetch-rtk.sh）。
#
# 为什么要重签名（见 docs/proposals/computer-use-cua-migration.md §12）:
#   macOS TCC 权限按【实际发起请求的 bundle】归属。官方 cua-driver 跑在
#   com.trycua.driver，授权弹窗写 "CuaDriver"；机器上还可能有 Yansu 内置的
#   com.yansu.cuadriver，open -a 会歧义命中、弹错品牌。重签成自有 bundle id
#   com.agentneo.computeruse + 名字 "Agent Neo Computer Use"，授权条目/弹窗即显示
#   Agent Neo Computer Use，并消除多 CuaDriver 冲突。
#
# 设计原则（对齐 fetch-rtk.sh）:
#   - 不 commit .app 进 git（产物在 .tauri-resources.noindex/，由 .gitignore 排除）
#   - 版本锁定：源 app 必须等于 CUA_DRIVER_VERSION，否则报错
#   - 增量：已重签且版本一致则跳过
#   - 重签用自有 Developer ID + hardened runtime，沿用源 app 的 entitlements
#   - 源优先级：CUA_DRIVER_SOURCE_APP 显式指定 > 官方锁定 release > 本机安装
# ============================================================================

set -euo pipefail

CUA_DRIVER_VERSION="0.8.1"
# 自有身份（弹窗/深链/图标都认这个 bundle id）
CUA_BUNDLE_ID="com.agentneo.computeruse"
CUA_APP_NAME="Agent Neo Computer Use"
# 重签身份：默认本机 Developer ID；CI 用 CUA_SIGN_IDENTITY 覆盖为 secret 注入的证书。
CUA_SIGN_IDENTITY="${CUA_SIGN_IDENTITY:-Developer ID Application: jay lem (D7CVTJ72NV)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STAGING_ROOT="$ROOT_DIR/.tauri-resources.noindex"
DEST_PARENT="$STAGING_ROOT/scripts"
DEST_APP="$DEST_PARENT/$CUA_APP_NAME.app"
DEST_BIN="$DEST_APP/Contents/MacOS/cua-driver"
MCP_LAUNCHER_SOURCE="$SCRIPT_DIR/lib/agent-neo-computer-use-mcp.sh"
DEST_MCP_LAUNCHER="$DEST_APP/Contents/Resources/agent-neo-computer-use-mcp.sh"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ fetch-cua-driver 仅支持 macOS（Windows 走 install.ps1，见提案 §2）" >&2
  exit 1
fi

# ── CI / 无本机源环境：拉取上游 universal release 后用 Neo 证书重签 ──
# checksum 来自同一 GitHub release 的 checksums.txt；版本、URL、sha 三者共同锁定。
CUA_UPSTREAM_TAG="cua-driver-rs-v${CUA_DRIVER_VERSION}"
CUA_UPSTREAM_ARCHIVE="cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz"
CUA_UPSTREAM_URL="https://github.com/trycua/cua/releases/download/${CUA_UPSTREAM_TAG}/${CUA_UPSTREAM_ARCHIVE}"
CUA_UPSTREAM_SHA256="dc6f901b03be002a5b4137ceafd9d02cb0eb0df9265e771c6530e7cfc0a6a4f2"
TMP_ROOT=""

cleanup_tmp() {
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup_tmp EXIT

prepare_destination_root() {
  mkdir -p "$DEST_PARENT"
  touch "$STAGING_ROOT/.metadata_never_index" 2>/dev/null || true
}

cleanup_legacy_script_app() {
  bash "$SCRIPT_DIR/stage-cua-driver-resource.sh" >/dev/null 2>&1 || true
}

# Apple 的 trusted timestamp 服务会间歇返回 errSecTimestampMissing。签名不能降级成
# 无时间戳，因此只做有界重试；三次仍失败就 fail closed 交给 CI/操作者重跑。
codesign_with_timestamp_retry() {
  local attempt
  for attempt in 1 2 3; do
    if codesign --force --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" --sign "$CUA_SIGN_IDENTITY" "$1"; then
      return 0
    fi
    if [[ "$attempt" -lt 3 ]]; then
      echo "⚠️ Apple timestamp 签名失败（${attempt}/3），5 秒后重试" >&2
      sleep 5
    fi
  done
  return 1
}

SOURCE_APP="${CUA_DRIVER_SOURCE_APP:-}"
FETCHED_UPSTREAM=0
if [[ "${CUA_FETCH_UPSTREAM:-${CUA_FETCH_PREBUILT:-}}" == "1" ]]; then
  prepare_destination_root
  TMP_ROOT="$(mktemp -d)"
  TMP_TAR="$TMP_ROOT/$CUA_UPSTREAM_ARCHIVE"
  echo "→ 下载上游锁定产物: $CUA_UPSTREAM_URL"
  curl -fL --retry 3 -o "$TMP_TAR" "$CUA_UPSTREAM_URL"
  ACTUAL_SHA="$(shasum -a 256 "$TMP_TAR" | awk '{print $1}')"
  if [[ "$ACTUAL_SHA" != "$CUA_UPSTREAM_SHA256" ]]; then
    echo "❌ sha256 不匹配: 实际=$ACTUAL_SHA 期望=$CUA_UPSTREAM_SHA256（供应链锁定，拒绝使用）" >&2
    exit 1
  fi
  tar -xzf "$TMP_TAR" -C "$TMP_ROOT"
  SOURCE_APP="$TMP_ROOT/cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal/CuaDriver.app"
  if [[ ! -d "$SOURCE_APP" ]]; then
    echo "❌ 上游归档缺少预期 CuaDriver.app: $SOURCE_APP" >&2
    exit 1
  fi
  FETCHED_UPSTREAM=1
fi

# ── 定位源 app ──────────────────────────────────────────────
SOURCE_APP="${SOURCE_APP:-/Applications/CuaDriver.app}"
if [[ ! -d "$SOURCE_APP" ]]; then
  echo "❌ 找不到源 cua-driver: $SOURCE_APP" >&2
  echo "   先装官方驱动: irm/curl https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh | sh" >&2
  echo "   或用 CUA_DRIVER_SOURCE_APP 指向已下载的 CuaDriver.app" >&2
  exit 1
fi

SOURCE_BIN="$SOURCE_APP/Contents/MacOS/cua-driver"
SRC_VERSION="$("$SOURCE_BIN" --version 2>/dev/null | awk '{print $2}')" || SRC_VERSION=""
if [[ "$SRC_VERSION" != "$CUA_DRIVER_VERSION" ]]; then
  echo "❌ 源 cua-driver 版本=$SRC_VERSION，期望=$CUA_DRIVER_VERSION（供应链锁定）" >&2
  echo "   升级官方驱动或调整 CUA_DRIVER_VERSION 后重试" >&2
  exit 1
fi

# ── 增量检查：已重签 + 自有 bundle id + 签名有效则跳过 ──
# 版本从 Info.plist 读取，避免旧版本签名有效时被错误复用。
if [[ "$FETCHED_UPSTREAM" != "1" && -d "$DEST_APP" ]]; then
  EXIST_ID="$(codesign -dv "$DEST_APP" 2>&1 | awk -F= '/^Identifier=/{print $2}')" || EXIST_ID=""
  EXIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST_APP/Contents/Info.plist" 2>/dev/null)" || EXIST_VERSION=""
  if [[ "$EXIST_ID" == "$CUA_BUNDLE_ID" && "$EXIST_VERSION" == "$CUA_DRIVER_VERSION" ]] \
    && [[ -x "$DEST_MCP_LAUNCHER" ]] \
    && cmp -s "$MCP_LAUNCHER_SOURCE" "$DEST_MCP_LAUNCHER" \
    && codesign --verify --strict "$DEST_APP" 2>/dev/null; then
    echo "✓ $CUA_APP_NAME.app ($CUA_DRIVER_VERSION, $CUA_BUNDLE_ID) 已就绪且签名有效（跳过）"
    exit 0
  fi
  echo "→ 检测到旧/无效产物（version=${EXIST_VERSION}, id=${EXIST_ID}），重建"
fi

# ── 校验签名身份存在 ────────────────────────────────────────
if ! security find-identity -v -p codesigning | grep -qF "$CUA_SIGN_IDENTITY"; then
  echo "❌ 钥匙串里找不到签名身份: $CUA_SIGN_IDENTITY" >&2
  echo "   可用身份:" >&2
  security find-identity -v -p codesigning >&2
  exit 1
fi

echo "→ 源: $SOURCE_APP (v$SRC_VERSION)"
echo "→ 目标: $DEST_APP (id=$CUA_BUNDLE_ID, sign=$CUA_SIGN_IDENTITY)"

# ── 复制 + 改身份 ───────────────────────────────────────────
prepare_destination_root
rm -rf "$DEST_APP"
cp -R "$SOURCE_APP" "$DEST_APP"
# 清掉源签名残留（必须，否则 codesign 拒绝覆盖）
rm -rf "$DEST_APP/Contents/_CodeSignature" "$DEST_APP/Contents/CodeResources"

PLIST="$DEST_APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $CUA_BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $CUA_APP_NAME" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string $CUA_APP_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $CUA_APP_NAME" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $CUA_APP_NAME" "$PLIST"

# MCP stdio 不能直接执行二进制：0.8.1 的默认 `mcp` 会用
# `open -a CuaDriver` 重启上游 daemon，TCC 因而仍归属 com.trycua.driver。
# launcher 随 app 一起签名，通过具体 bundle URL 拉起 Neo 专用 daemon。
if [[ ! -f "$MCP_LAUNCHER_SOURCE" ]]; then
  echo "❌ 找不到 TCC launcher: $MCP_LAUNCHER_SOURCE" >&2
  exit 1
fi
mkdir -p "$DEST_APP/Contents/Resources"
install -m 0755 "$MCP_LAUNCHER_SOURCE" "$DEST_MCP_LAUNCHER"

# LaunchServices 启动的 daemon 不依赖父 shell 环境；把禁遥测/禁更新写进
# 已签名 bundle 的启动环境，避免 stdio 配置与真实 responsible process 漂移。
/usr/libexec/PlistBuddy -c "Delete :LSEnvironment" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSEnvironment dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:CUA_DRIVER_RS_TELEMETRY_ENABLED string false" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSEnvironment:CUA_DRIVER_RS_UPDATE_CHECK string 0" "$PLIST"

# ── entitlements：必须带 disable-library-validation ──
# cua-driver 用自有 Developer ID 重签后 team id 变了，hardened runtime 默认的
# Library Validation 会在运行时 SIGKILL（实测 exit 137）。专用 entitlements 关掉 LV。
ENTITLEMENTS="$SCRIPT_DIR/cua-driver.entitlements"
if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "❌ 找不到 entitlements: $ENTITLEMENTS（应与本脚本同目录，随仓库提交）" >&2
  exit 1
fi

# 先签内部二进制，再签 .app（避免 --deep 的已知坑），统一 hardened runtime + timestamp
codesign_with_timestamp_retry "$DEST_BIN"
codesign_with_timestamp_retry "$DEST_APP"

# ── 验证 ────────────────────────────────────────────────────
codesign --verify --strict --verbose=2 "$DEST_APP"
NEW_ID="$(codesign -dv "$DEST_APP" 2>&1 | awk -F= '/^Identifier=/{print $2}')"
if [[ "$NEW_ID" != "$CUA_BUNDLE_ID" ]]; then
  echo "❌ 重签后 bundle id=$NEW_ID，期望 $CUA_BUNDLE_ID" >&2
  exit 1
fi
if [[ ! -x "$DEST_MCP_LAUNCHER" ]] || ! cmp -s "$MCP_LAUNCHER_SOURCE" "$DEST_MCP_LAUNCHER"; then
  echo "❌ TCC launcher 未正确写入签名 helper" >&2
  exit 1
fi
echo "✓ $CUA_APP_NAME.app ($CUA_DRIVER_VERSION) 重签完成 → bundle id $NEW_ID"
echo "  二进制: $DEST_BIN"
echo "  注：本地 dogfood 无需公证；正式发版由 release.yml 在 CI 用 secret 证书签名+公证。"
cleanup_legacy_script_app
