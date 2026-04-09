#!/usr/bin/env bash
# ============================================================================
# 构建 system-audio-capture Swift 工具
# ============================================================================
# 依赖: macOS + swiftc（Xcode Command Line Tools）
# 产物: scripts/system-audio-capture（Mach-O arm64）
# 触发时机: 首次 clone 后、scripts/system-audio-capture.swift 变更后
#
# 与 desktopAudioCapture.ts::findSystemAudioCaptureBinary() 的 runtime
# 编译逻辑保持相同 swiftc 参数，避免行为差异。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/system-audio-capture.swift"
OUTPUT="$SCRIPT_DIR/system-audio-capture"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ system-audio-capture 仅支持 macOS" >&2
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
  echo "✓ system-audio-capture 已是最新（源文件未变）"
  exit 0
fi

echo "→ 编译 system-audio-capture..."
swiftc \
  -O \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -o "$OUTPUT" \
  "$SOURCE"

chmod +x "$OUTPUT"
echo "✓ 产物: $OUTPUT"
ls -lh "$OUTPUT"
