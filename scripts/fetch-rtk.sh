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
# 上游每个平台/arch 的归档 + binary sha256（本地实拉计算，供应链锁定，禁止伪造）。
RTK_SHA256_AARCH64_DARWIN="0d140babfba54c37298b32e7b2ad1f21c72179b22bbcdf01c9cd66bb9ae28855"
RTK_BIN_SHA256_AARCH64_DARWIN="7add15f7979c77f3523cdb4a69f46516469edd4ee731e60676e5dfa00492e39c"
RTK_SHA256_X86_64_DARWIN="c3bb225d69c72a1a190f5d341b3958bf923c7242874627ef2d9f802d3743ff5c"
RTK_BIN_SHA256_X86_64_DARWIN="b9ac6819d2b5af7fcc64027ea6d4635832de8dfb706121733e7ae128192b6d5a"
# windows-msvc（2026-06-10 实拉计算）
RTK_SHA256_X86_64_WINDOWS_ZIP="aad430c14d82b4470f14bdb9695e8cd97aeac97444bd087bd70be161ced09cb7"
RTK_BIN_SHA256_X86_64_WINDOWS="731583957e8cea7cfa858fb56835c001b71f75e595710a5441ebaee12fc6c83b"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 平台感知：Darwin 走 tar.gz，Windows（CI 上经 Git Bash 调用）走 msvc zip。
# FETCH_PLATFORM_OVERRIDE 供本机交叉拉取验证。
UNAME="$(uname)"
PLATFORM="${FETCH_PLATFORM_OVERRIDE:-}"
if [[ -z "$PLATFORM" ]]; then
  case "$UNAME" in
    Darwin) PLATFORM="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *) echo "❌ fetch-rtk 仅支持 macOS / Windows(Git Bash)" >&2; exit 1 ;;
  esac
fi

if [[ "$PLATFORM" == "windows" ]]; then
  OUTPUT="$SCRIPT_DIR/rtk.exe"
  RTK_ARCH="x86_64"
  EXPECT_TAR_SHA="$RTK_SHA256_X86_64_WINDOWS_ZIP"
  EXPECT_BIN_SHA="$RTK_BIN_SHA256_X86_64_WINDOWS"
else
  OUTPUT="$SCRIPT_DIR/rtk"
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
fi

# Git Bash 默认无 unzip 时退回系统 bsdtar（Server 2019+ 自带，能解 zip）
extract_zip() {
  local zip_path="$1" dest_dir="$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$zip_path" -d "$dest_dir"
  elif [[ -x "/c/Windows/System32/tar.exe" ]]; then
    "/c/Windows/System32/tar.exe" -xf "$(cygpath -w "$zip_path")" -C "$(cygpath -w "$dest_dir")"
  else
    echo "❌ 找不到 unzip 或系统 tar，无法解 zip" >&2
    exit 1
  fi
}

# 增量检查: 已存在 + 版本一致则跳过
if [[ -x "$OUTPUT" ]]; then
  EXISTING_VERSION="$("$OUTPUT" --version 2>/dev/null | awk '{print $2}')" || EXISTING_VERSION=""
  if [[ "$EXISTING_VERSION" == "$RTK_VERSION" ]]; then
    echo "✓ rtk $RTK_VERSION 已是目标版本（跳过下载）"
    exit 0
  fi
  echo "→ 检测到旧版本 $EXISTING_VERSION，升级到 $RTK_VERSION"
fi

if [[ "$PLATFORM" == "windows" ]]; then
  ASSET="rtk-${RTK_ARCH}-pc-windows-msvc.zip"
else
  ASSET="rtk-${RTK_ARCH}-apple-darwin.tar.gz"
fi
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

if [[ "$PLATFORM" == "windows" ]]; then
  # windows zip 结构: 根目录平铺 rtk.exe（实拉确认）
  extract_zip "$TMP_DIR/$ASSET" "$TMP_DIR"
  EXTRACTED_BIN="$TMP_DIR/rtk.exe"
else
  tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
  EXTRACTED_BIN="$TMP_DIR/rtk"
fi

ACTUAL_BIN_SHA="$(shasum -a 256 "$EXTRACTED_BIN" | awk '{print $1}')"
if [[ "$ACTUAL_BIN_SHA" != "$EXPECT_BIN_SHA" ]]; then
  echo "❌ binary sha256 不匹配 (arch=$RTK_ARCH)" >&2
  echo "   预期: $EXPECT_BIN_SHA" >&2
  echo "   实际: $ACTUAL_BIN_SHA" >&2
  exit 1
fi
echo "✓ binary sha256 验证通过"

mv "$EXTRACTED_BIN" "$OUTPUT"
chmod +x "$OUTPUT"
echo "✓ rtk $RTK_VERSION ($PLATFORM-$RTK_ARCH) → $OUTPUT"
