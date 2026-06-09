#!/usr/bin/env bash
# ============================================================================
# 拉取 rtk (Rust Token Killer) sidecar binary
# ============================================================================
# 上游: https://github.com/rtk-ai/rtk (MIT)
# 用途: 在 Neo 内部 Bash tool 执行链路里 wrap 命令做 token-saving
# 触发时机: 首次 clone 后、需要升级 RTK_VERSION 时
#
# 设计原则:
#   - 不 commit binary 进 git (跟 vision-ocr 同模式)
#   - 强制 sha256 验证 (上游 release 提供 checksums.txt)
#   - 增量: 已存在且版本匹配则跳过
#   - arch 感知: arm64 + x86_64 双架构，CI 可用 RTK_ARCH_OVERRIDE 交叉拉取
# ============================================================================

set -euo pipefail

RTK_VERSION="0.39.0"
# 上游每个 arch 的 tarball + binary sha256（本地实拉计算，供应链锁定，禁止伪造）。
RTK_SHA256_AARCH64_DARWIN="0d140babfba54c37298b32e7b2ad1f21c72179b22bbcdf01c9cd66bb9ae28855"
RTK_BIN_SHA256_AARCH64_DARWIN="7add15f7979c77f3523cdb4a69f46516469edd4ee731e60676e5dfa00492e39c"
RTK_SHA256_X86_64_DARWIN="c3bb225d69c72a1a190f5d341b3958bf923c7242874627ef2d9f802d3743ff5c"
RTK_BIN_SHA256_X86_64_DARWIN="b9ac6819d2b5af7fcc64027ea6d4635832de8dfb706121733e7ae128192b6d5a"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="$SCRIPT_DIR/rtk"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ fetch-rtk 仅支持 macOS" >&2
  exit 1
fi

# arch 感知：arm64 → aarch64，Intel → x86_64。RTK_ARCH_OVERRIDE 供 CI 交叉拉取。
ARCH="${RTK_ARCH_OVERRIDE:-$(uname -m)}"
case "$ARCH" in
  arm64|aarch64)
    RTK_ARCH="aarch64"
    EXPECT_TAR_SHA="$RTK_SHA256_AARCH64_DARWIN"
    EXPECT_BIN_SHA="$RTK_BIN_SHA256_AARCH64_DARWIN"
    ;;
  x86_64|x64)
    RTK_ARCH="x86_64"
    EXPECT_TAR_SHA="$RTK_SHA256_X86_64_DARWIN"
    EXPECT_BIN_SHA="$RTK_BIN_SHA256_X86_64_DARWIN"
    ;;
  *)
    echo "❌ 不支持的 arch=$ARCH（仅 arm64 / x86_64）" >&2
    exit 1
    ;;
esac

# 增量检查: 已存在 + 版本一致则跳过
if [[ -x "$OUTPUT" ]]; then
  EXISTING_VERSION="$("$OUTPUT" --version 2>/dev/null | awk '{print $2}')" || EXISTING_VERSION=""
  if [[ "$EXISTING_VERSION" == "$RTK_VERSION" ]]; then
    echo "✓ rtk $RTK_VERSION 已是目标版本（跳过下载）"
    exit 0
  fi
  echo "→ 检测到旧版本 $EXISTING_VERSION，升级到 $RTK_VERSION"
fi

ASSET="rtk-${RTK_ARCH}-apple-darwin.tar.gz"
URL="https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${ASSET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "→ 下载 $URL"
if ! curl -fsSL -o "$TMP_DIR/$ASSET" "$URL"; then
  echo "❌ 下载失败 — 国际域名需要代理，可设置 HTTPS_PROXY=http://127.0.0.1:7897" >&2
  exit 1
fi

ACTUAL_TAR_SHA="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
if [[ "$ACTUAL_TAR_SHA" != "$EXPECT_TAR_SHA" ]]; then
  echo "❌ tarball sha256 不匹配 (arch=$RTK_ARCH)" >&2
  echo "   预期: $EXPECT_TAR_SHA" >&2
  echo "   实际: $ACTUAL_TAR_SHA" >&2
  exit 1
fi
echo "✓ tarball sha256 验证通过"

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
ACTUAL_BIN_SHA="$(shasum -a 256 "$TMP_DIR/rtk" | awk '{print $1}')"
if [[ "$ACTUAL_BIN_SHA" != "$EXPECT_BIN_SHA" ]]; then
  echo "❌ binary sha256 不匹配 (arch=$RTK_ARCH)" >&2
  echo "   预期: $EXPECT_BIN_SHA" >&2
  echo "   实际: $ACTUAL_BIN_SHA" >&2
  exit 1
fi
echo "✓ binary sha256 验证通过"

mv "$TMP_DIR/rtk" "$OUTPUT"
chmod +x "$OUTPUT"
echo "✓ rtk $RTK_VERSION ($RTK_ARCH) → $OUTPUT"
