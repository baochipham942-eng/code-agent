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
# ============================================================================

set -euo pipefail

RTK_VERSION="0.39.0"
RTK_SHA256_AARCH64_DARWIN="0d140babfba54c37298b32e7b2ad1f21c72179b22bbcdf01c9cd66bb9ae28855"
RTK_BIN_SHA256_AARCH64_DARWIN="7add15f7979c77f3523cdb4a69f46516469edd4ee731e60676e5dfa00492e39c"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="$SCRIPT_DIR/rtk"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ fetch-rtk 仅支持 macOS (Neo Tauri 发行版本目前只发 arm64 macOS)" >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "❌ 当前 arch=$ARCH，rtk sidecar 目前仅打 arm64-apple-darwin" >&2
  exit 1
fi

# 增量检查: 已存在 + 版本一致则跳过
if [[ -x "$OUTPUT" ]]; then
  EXISTING_VERSION="$("$OUTPUT" --version 2>/dev/null | awk '{print $2}')" || EXISTING_VERSION=""
  if [[ "$EXISTING_VERSION" == "$RTK_VERSION" ]]; then
    echo "✓ rtk $RTK_VERSION 已是目标版本（跳过下载）"
    exit 0
  fi
  echo "→ 检测到旧版本 $EXISTING_VERSION，升级到 $RTK_VERSION"
fi

ASSET="rtk-aarch64-apple-darwin.tar.gz"
URL="https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${ASSET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "→ 下载 $URL"
if ! curl -fsSL -o "$TMP_DIR/$ASSET" "$URL"; then
  echo "❌ 下载失败 — 国际域名需要代理，可设置 HTTPS_PROXY=http://127.0.0.1:7897" >&2
  exit 1
fi

ACTUAL_TAR_SHA="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
if [[ "$ACTUAL_TAR_SHA" != "$RTK_SHA256_AARCH64_DARWIN" ]]; then
  echo "❌ tarball sha256 不匹配" >&2
  echo "   预期: $RTK_SHA256_AARCH64_DARWIN" >&2
  echo "   实际: $ACTUAL_TAR_SHA" >&2
  exit 1
fi
echo "✓ tarball sha256 验证通过"

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
ACTUAL_BIN_SHA="$(shasum -a 256 "$TMP_DIR/rtk" | awk '{print $1}')"
if [[ "$ACTUAL_BIN_SHA" != "$RTK_BIN_SHA256_AARCH64_DARWIN" ]]; then
  echo "❌ binary sha256 不匹配" >&2
  echo "   预期: $RTK_BIN_SHA256_AARCH64_DARWIN" >&2
  echo "   实际: $ACTUAL_BIN_SHA" >&2
  exit 1
fi
echo "✓ binary sha256 验证通过"

mv "$TMP_DIR/rtk" "$OUTPUT"
chmod +x "$OUTPUT"
echo "✓ rtk $RTK_VERSION → $OUTPUT"
