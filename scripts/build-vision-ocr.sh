#!/usr/bin/env bash
# ============================================================================
# 构建 vision-ocr Swift 工具
# ============================================================================
# 依赖: macOS + swiftc（Xcode Command Line Tools）
# 产物: scripts/vision-ocr（Mach-O arm64）
# 触发时机: 首次 clone 后、scripts/vision-ocr.swift 变更后
#
# 跟 ocrSearch.ts 里 spawn 调用的 binary 路径保持一致。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/vision-ocr.swift"
OUTPUT="$SCRIPT_DIR/vision-ocr"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ vision-ocr 仅支持 macOS" >&2
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

# 增量检查：源文件未变且产物较新则跳过
if [[ -f "$OUTPUT" && "$OUTPUT" -nt "$SOURCE" ]]; then
  echo "✓ vision-ocr 已是最新（源文件未变）"
  exit 0
fi

echo "→ 编译 vision-ocr..."
swiftc \
  -O \
  -framework Vision \
  -framework AppKit \
  -o "$OUTPUT" \
  "$SOURCE"

chmod +x "$OUTPUT"
echo "✓ 产物: $OUTPUT"
ls -lh "$OUTPUT"
