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

# arch 感知交叉编译：SWIFT_BUILD_ARCH=x86_64|arm64 显式指定（CI 出 x64 包用）。
# 不设则编当前架构（保持原行为，沿用 SDK 默认部署目标）。
# 最低系统版本 13.0：ScreenCaptureKit 的 SCStream(12.3) + capturesAudio(13.0) 实测下限。
# Intel Mac 跑 macOS ≤15（macOS 26 Tahoe 已弃 Intel），13.0 在 Intel 可用区间内地板。
SWIFT_MIN_MACOS="13.0"
TARGET_ARGS=()
case "${SWIFT_BUILD_ARCH:-}" in
  x86_64|x64)    TARGET_ARGS=(-target "x86_64-apple-macos${SWIFT_MIN_MACOS}") ;;
  arm64|aarch64) TARGET_ARGS=(-target "arm64-apple-macos${SWIFT_MIN_MACOS}") ;;
  "") ;;
  *) echo "❌ 不支持的 SWIFT_BUILD_ARCH=${SWIFT_BUILD_ARCH}（仅 x86_64 / arm64）" >&2; exit 1 ;;
esac

# 增量检查：源文件未变且产物较新则跳过（交叉编译指定 arch 时强制重编，避免拿到宿主架构旧产物）
if [[ -z "${SWIFT_BUILD_ARCH:-}" && -f "$OUTPUT" && "$OUTPUT" -nt "$SOURCE" ]]; then
  echo "✓ system-audio-capture 已是最新（源文件未变）"
  exit 0
fi

echo "→ 编译 system-audio-capture${SWIFT_BUILD_ARCH:+ (target=$SWIFT_BUILD_ARCH)}..."
swiftc \
  -O \
  ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -o "$OUTPUT" \
  "$SOURCE"

chmod +x "$OUTPUT"
echo "✓ 产物: $OUTPUT"
ls -lh "$OUTPUT"
