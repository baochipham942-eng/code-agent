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
# ============================================================================

set -euo pipefail

UV_VERSION="0.11.16"
UV_SHA256_AARCH64_DARWIN_TAR="2b25be1af546be330b340b0a76b99f989daa6d92678fdffb87438e661e9d88fb"
UV_BIN_SHA256_AARCH64_DARWIN="f63ec276fa13f8f392542a334c0f58f36833b24304831e5f4c221e2edf7a16f3"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="$SCRIPT_DIR/uv"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ fetch-uv 仅支持 macOS (Neo Tauri 发行版本目前只发 arm64 macOS)" >&2
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "❌ 当前 arch=$ARCH,uv sidecar 目前仅打 arm64-apple-darwin" >&2
  exit 1
fi

# 增量检查
if [[ -x "$OUTPUT" ]]; then
  EXISTING_VERSION="$("$OUTPUT" --version 2>/dev/null | awk '{print $2}')" || EXISTING_VERSION=""
  if [[ "$EXISTING_VERSION" == "$UV_VERSION" ]]; then
    echo "✓ uv $UV_VERSION 已是目标版本(跳过下载)"
    exit 0
  fi
  echo "→ 检测到旧版本 $EXISTING_VERSION,升级到 $UV_VERSION"
fi

ASSET="uv-aarch64-apple-darwin.tar.gz"
URL="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${ASSET}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "→ 下载 $URL"
if ! curl -fsSL -o "$TMP_DIR/$ASSET" "$URL"; then
  echo "❌ 下载失败 — 国际域名需要代理,可设置 HTTPS_PROXY=http://127.0.0.1:7897" >&2
  exit 1
fi

ACTUAL_TAR_SHA="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"
if [[ "$ACTUAL_TAR_SHA" != "$UV_SHA256_AARCH64_DARWIN_TAR" ]]; then
  echo "❌ tarball sha256 不匹配" >&2
  echo "   预期: $UV_SHA256_AARCH64_DARWIN_TAR" >&2
  echo "   实际: $ACTUAL_TAR_SHA" >&2
  exit 1
fi
echo "✓ tarball sha256 验证通过"

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR"
# uv tarball 结构: uv-aarch64-apple-darwin/{uv, uvx}
# 只需要 uv (setup-gliner-pii 只用 uv venv + uv pip install,不用 uvx)
EXTRACTED_BIN="$TMP_DIR/uv-aarch64-apple-darwin/uv"
if [[ ! -f "$EXTRACTED_BIN" ]]; then
  echo "❌ 解压后找不到 uv binary 在预期路径 $EXTRACTED_BIN" >&2
  exit 1
fi

ACTUAL_BIN_SHA="$(shasum -a 256 "$EXTRACTED_BIN" | awk '{print $1}')"
if [[ "$ACTUAL_BIN_SHA" != "$UV_BIN_SHA256_AARCH64_DARWIN" ]]; then
  echo "❌ binary sha256 不匹配" >&2
  echo "   预期: $UV_BIN_SHA256_AARCH64_DARWIN" >&2
  echo "   实际: $ACTUAL_BIN_SHA" >&2
  exit 1
fi
echo "✓ binary sha256 验证通过"

mv "$EXTRACTED_BIN" "$OUTPUT"
chmod +x "$OUTPUT"
echo "✓ uv $UV_VERSION → $OUTPUT"
