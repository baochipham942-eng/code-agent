#!/usr/bin/env bash
# ============================================================================
# 重签名 cua-driver (trycua, MIT) → "Agent Neo Computer Use.app"
# ============================================================================
# 上游: https://github.com/trycua/cua (libs/cua-driver, MIT)
# 用途: Neo 的 computer-use 新底座（AX 树优先 + 后台不抢焦点），stdio MCP 接入。
# 触发时机: 首次 clone 后、需要升级 CUA_DRIVER_VERSION 时（同 fetch-rtk.sh）。
#
# 为什么要重签名（见 docs/proposals/computer-use-cua-migration.md §12）:
#   macOS TCC 权限按【实际发起请求的 bundle】归属。官方 cua-driver 跑在
#   com.trycua.driver，授权弹窗写 "CuaDriver"；机器上还可能有 Yansu 内置的
#   com.yansu.cuadriver，open -a 会歧义命中、弹错品牌。重签成自有 bundle id
#   com.agentneo.computeruse + 名字 "Agent Neo Computer Use"，弹窗即显示
#   Agent Neo，并消除多 CuaDriver 冲突。
#
# 设计原则（对齐 fetch-rtk.sh）:
#   - 不 commit .app 进 git（产物在 scripts/，由 .gitignore 排除）
#   - 版本锁定：源 app 必须等于 CUA_DRIVER_VERSION，否则报错
#   - 增量：已重签且版本一致则跳过
#   - 重签用自有 Developer ID + hardened runtime，沿用源 app 的 entitlements
#   - 源优先级：CUA_DRIVER_SOURCE_APP 显式指定 > 本机已装官方 CuaDriver.app
#     （CI 可先 download 官方 release 再用 CUA_DRIVER_SOURCE_APP 指过去）
# ============================================================================

set -euo pipefail

CUA_DRIVER_VERSION="0.5.1"
# 自有身份（弹窗/深链/图标都认这个 bundle id）
CUA_BUNDLE_ID="com.agentneo.computeruse"
CUA_APP_NAME="Agent Neo Computer Use"
# 重签身份：默认本机 Developer ID；CI 用 CUA_SIGN_IDENTITY 覆盖为 secret 注入的证书。
CUA_SIGN_IDENTITY="${CUA_SIGN_IDENTITY:-Developer ID Application: jay lem (D7CVTJ72NV)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_APP="$SCRIPT_DIR/$CUA_APP_NAME.app"
DEST_BIN="$DEST_APP/Contents/MacOS/cua-driver"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ fetch-cua-driver 仅支持 macOS（Windows 走 install.ps1，见提案 §2）" >&2
  exit 1
fi

# ── 定位源 app ──────────────────────────────────────────────
SOURCE_APP="${CUA_DRIVER_SOURCE_APP:-/Applications/CuaDriver.app}"
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
# 注意：不执行 dest 二进制来取版本——半成品的 hardened 签名会被 macOS SIGKILL。
# 只读 codesign 身份 + 验签；版本锁定靠上面对 SOURCE 的校验保证。
if [[ -d "$DEST_APP" ]]; then
  EXIST_ID="$(codesign -dv "$DEST_APP" 2>&1 | awk -F= '/^Identifier=/{print $2}')" || EXIST_ID=""
  if [[ "$EXIST_ID" == "$CUA_BUNDLE_ID" ]] && codesign --verify --strict "$DEST_APP" 2>/dev/null; then
    echo "✓ $CUA_APP_NAME.app ($CUA_BUNDLE_ID) 已就绪且签名有效（跳过）"
    exit 0
  fi
  echo "→ 检测到旧/无效产物（id=$EXIST_ID），重建"
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

# ── entitlements：必须带 disable-library-validation ──
# cua-driver 用自有 Developer ID 重签后 team id 变了，hardened runtime 默认的
# Library Validation 会在运行时 SIGKILL（实测 exit 137）。专用 entitlements 关掉 LV。
ENTITLEMENTS="$SCRIPT_DIR/cua-driver.entitlements"
if [[ ! -f "$ENTITLEMENTS" ]]; then
  echo "❌ 找不到 entitlements: $ENTITLEMENTS（应与本脚本同目录，随仓库提交）" >&2
  exit 1
fi

# 先签内部二进制，再签 .app（避免 --deep 的已知坑），统一 hardened runtime + timestamp
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$CUA_SIGN_IDENTITY" "$DEST_BIN"
codesign --force --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" --sign "$CUA_SIGN_IDENTITY" "$DEST_APP"

# ── 验证 ────────────────────────────────────────────────────
codesign --verify --strict --verbose=2 "$DEST_APP"
NEW_ID="$(codesign -dv "$DEST_APP" 2>&1 | awk -F= '/^Identifier=/{print $2}')"
if [[ "$NEW_ID" != "$CUA_BUNDLE_ID" ]]; then
  echo "❌ 重签后 bundle id=$NEW_ID，期望 $CUA_BUNDLE_ID" >&2
  exit 1
fi
echo "✓ $CUA_APP_NAME.app ($CUA_DRIVER_VERSION) 重签完成 → bundle id $NEW_ID"
echo "  二进制: $DEST_BIN"
echo "  注：本地 dogfood 无需公证；正式发版由 release.yml 在 CI 用 secret 证书签名+公证。"
