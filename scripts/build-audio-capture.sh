#!/usr/bin/env bash
# ============================================================================
# 构建 macOS Swift 音频工具
# ============================================================================
# 依赖: macOS + swiftc（Xcode Command Line Tools）
# 产物: scripts/system-audio-capture、scripts/voice-aec-io
# 触发时机: 首次 clone 后、scripts/system-audio-capture.swift 变更后
#
# 与 desktopAudioCapture.ts::findSystemAudioCaptureBinary() 的 runtime
# 编译逻辑保持相同 swiftc 参数，避免行为差异。
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$(uname)" != "Darwin" ]]; then
  echo "❌ Swift 音频工具仅支持 macOS" >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "❌ 找不到 swiftc — 请安装 Xcode Command Line Tools：xcode-select --install" >&2
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

build_swift_tool() {
  local name="$1"
  shift
  local source="$SCRIPT_DIR/$name.swift"
  local output="$SCRIPT_DIR/$name"

  if [[ ! -f "$source" ]]; then
    echo "❌ Swift 源文件缺失: $source" >&2
    exit 1
  fi

  # 增量检查：源文件未变且产物较新则跳过（交叉编译指定 arch 时强制重编）。
  if [[ -z "${SWIFT_BUILD_ARCH:-}" && -f "$output" && "$output" -nt "$source" ]]; then
    echo "✓ $name 已是最新（源文件未变）"
    return
  fi

  echo "→ 编译 $name${SWIFT_BUILD_ARCH:+ (target=$SWIFT_BUILD_ARCH)}..."
  swiftc \
    -O \
    ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} \
    "$@" \
    -o "$output" \
    "$source"

  chmod +x "$output"
  echo "✓ 产物: $output"
  ls -lh "$output"
}

build_swift_tool system-audio-capture \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia

build_swift_tool voice-aec-io \
  -framework AVFoundation \
  -framework AudioToolbox \
  -framework CoreAudio
