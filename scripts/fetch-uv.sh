#!/usr/bin/env bash
# ============================================================================
# 拉取 uv (Astral Python package manager) sidecar binary
# ============================================================================
# 上游: https://github.com/astral-sh/uv (MIT/Apache-2.0)
# 用途: 给 scripts/pii/setup-gliner-pii.sh 一键创建 GLiNER venv,不依赖系统 Python/uv
# 触发时机: 首次 clone 后、需要升级 UV_VERSION 时
#
# 设计原则:
#   - 不 commit binary 进 git (跟 fetch-rtk 同模式)
#   - 强制 sha256 验证 (上游每个 asset 提供 .sha256 文件)
#   - 增量: 已存在且版本匹配则跳过
#   - arch 感知: arm64 + x86_64 双架构，CI 可用 UV_ARCH_OVERRIDE 交叉拉取
# ============================================================================

set -euo pipefail

UV_VERSION="0.11.16"
# 上游每个平台/arch 的归档 + binary sha256（本地实拉计算，供应链锁定，禁止伪造）。
UV_SHA256_AARCH64_DARWIN_TAR="2b25be1af546be330b340b0a76b99f989daa6d92678fdffb87438e661e9d88fb"
UV_BIN_SHA256_AARCH64_DARWIN="f63ec276fa13f8f392542a334c0f58f36833b24304831e5f4c221e2edf7a16f3"
UV_SHA256_X86_64_DARWIN_TAR="6b91ae3de155f51bd1f5b74814821c79f016a176561f252cd9ddfb976939af2e"
UV_BIN_SHA256_X86_64_DARWIN="51aad75fa6c40c5f1f3f2b2f2ce7ad49faf4723e333d94c820510cf2acf04f49"
# windows-msvc（2026-06-10 实拉，zip 哈希与上游官方 .sha256 文件一致）
UV_SHA256_X86_64_WINDOWS_ZIP="dd9d6d6554bfab265bfa98aa8e8a406c5c3a7b97582f93de1f4d48d9154a0395"
UV_BIN_SHA256_X86_64_WINDOWS="c5a583d5f1f6d055fc1c32c87d8eceee90edc69a5b9af5da70811befdfc04880"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 平台感知：Darwin 走 tar.gz，Windows（CI 上经 Git Bash 调用）走 msvc zip。
# FETCH_PLATFORM_OVERRIDE 供本机交叉拉取验证。
UNAME="$(uname)"
PLATFORM="${FETCH_PLATFORM_OVERRIDE:-}"
if [[ -z "$PLATFORM" ]]; then
  case "$UNAME" in
    Darwin) PLATFORM="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *) echo "❌ fetch-uv 仅支持 macOS / Windows(Git Bash)" >&2; exit 1 ;;
  esac
fi

if [[ "$PLATFORM" == "windows" ]]; then
  OUTPUT="$SCRIPT_DIR/uv.exe"
  UV_ARCH="x86_64"
  EXPECT_TAR_SHA="$UV_SHA256_X86_64_WINDOWS_ZIP"
  EXPECT_BIN_SHA="$UV_BIN_SHA256_X86_64_WINDOWS"
else
  OUTPUT="$SCRIPT_DIR/uv"
  # arch 感知：arm64 → aarch64，Intel → x86_64。UV_ARCH_OVERRIDE 供 CI 交叉拉取。
  ARCH="${UV_ARCH_OVERRIDE:-$(uname -m)}"
  case "$ARCH" in
    arm64|aarch64)
      UV_ARCH="aarch64"
      EXPECT_TAR_SHA="$UV_SHA256_AARCH64_DARWIN_TAR"
      EXPECT_BIN_SHA="$UV_BIN_SHA256_AARCH64_DARWIN"
      ;;
    x86_64|x64)
      UV_ARCH="x86_64"
      EXPECT_TAR_SHA="$UV_SHA256_X86_64_DARWIN_TAR"
      EXPECT_BIN_SHA="$UV_BIN_SHA256_X86_64_DARWIN"
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

# 增量检查
if [[ -x "$OUTPUT" ]]; then
  EXISTING_VERSION="$("$OUTPUT" --version 2>/dev/null | awk '{print $2}')" || EXISTING_VERSION=""
  if [[ "$EXISTING_VERSION" == "$UV_VERSION" ]]; then
    echo "✓ uv $UV_VERSION 已是目标版本(跳过下载)"
    exit 0
  fi
  echo "→ 检测到旧版本 $EXISTING_VERSION,升级到 $UV_VERSION"
fi

if [[ "$PLATFORM" == "windows" ]]; then
  ASSET="uv-${UV_ARCH}-pc-windows-msvc.zip"
else
  ASSET="uv-${UV_ARCH}-apple-darwin.tar.gz"
fi
URL="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${ASSET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "→ 下载 $URL"
if ! curl -fsSL -o "$TMP_DIR/$ASSET" "$URL"; then
  echo "❌ 下载失败 — 国际域名需要代理,可设置 HTTPS_PROXY=http://127.0.0.1:7897" >&2
  exit 1
fi

ACTUAL_TAR_SHA="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
if [[ "$ACTUAL_TAR_SHA" != "$EXPECT_TAR_SHA" ]]; then
  echo "❌ tarball sha256 不匹配 (arch=$UV_ARCH)" >&2
  echo "   预期: $EXPECT_TAR_SHA" >&2
  echo "   实际: $ACTUAL_TAR_SHA" >&2
  exit 1
fi
echo "✓ tarball sha256 验证通过"

if [[ "$PLATFORM" == "windows" ]]; then
  # windows zip 结构: 根目录平铺 {uv.exe, uvw.exe, uvx.exe}（实拉确认）
  extract_zip "$TMP_DIR/$ASSET" "$TMP_DIR"
  EXTRACTED_BIN="$TMP_DIR/uv.exe"
else
  tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
  # uv tarball 结构: uv-${UV_ARCH}-apple-darwin/{uv, uvx}
  # 只需要 uv (setup-gliner-pii 只用 uv venv + uv pip install,不用 uvx)
  EXTRACTED_BIN="$TMP_DIR/uv-${UV_ARCH}-apple-darwin/uv"
fi
if [[ ! -f "$EXTRACTED_BIN" ]]; then
  echo "❌ 解压后找不到 uv binary 在预期路径 $EXTRACTED_BIN" >&2
  exit 1
fi

ACTUAL_BIN_SHA="$(shasum -a 256 "$EXTRACTED_BIN" | awk '{print $1}')"
if [[ "$ACTUAL_BIN_SHA" != "$EXPECT_BIN_SHA" ]]; then
  echo "❌ binary sha256 不匹配 (arch=$UV_ARCH)" >&2
  echo "   预期: $EXPECT_BIN_SHA" >&2
  echo "   实际: $ACTUAL_BIN_SHA" >&2
  exit 1
fi
echo "✓ binary sha256 验证通过"

mv "$EXTRACTED_BIN" "$OUTPUT"
chmod +x "$OUTPUT"
echo "✓ uv $UV_VERSION ($PLATFORM-$UV_ARCH) → $OUTPUT"
