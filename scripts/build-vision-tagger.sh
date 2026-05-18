#!/usr/bin/env bash
# ============================================================================
# 构建 vision-tagger Swift 工具（人脸检测 + 主题分类）
# ============================================================================
# 依赖: macOS + swiftc（Xcode Command Line Tools）
# 产物: scripts/vision-tagger（Mach-O arm64）
# 触发时机: 首次 clone 后、scripts/vision-tagger.swift 变更后
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/vision-tagger.swift"
OUTPUT="$SCRIPT_DIR/vision-tagger"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ vision-tagger 仅支持 macOS" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "❌ 找不到 swiftc — 请安装 Xcode Command Line Tools：xcode-select --install" >&2
  exit 1
fi

if [[ ! -f "$SOURCE" ]]; then
  echo "❌ Swift 源文件缺失: $SOURCE" >&2
  exit 1
fi

if [[ -f "$OUTPUT" && "$OUTPUT" -nt "$SOURCE" ]]; then
  echo "✓ vision-tagger 已是最新（源文件未变）"
  exit 0
fi

echo "→ 编译 vision-tagger..."
swiftc \
  -O \
  -framework Vision \
  -framework AppKit \
  -o "$OUTPUT" \
  "$SOURCE"

chmod +x "$OUTPUT"
echo "✓ 产物: $OUTPUT"
ls -lh "$OUTPUT"
