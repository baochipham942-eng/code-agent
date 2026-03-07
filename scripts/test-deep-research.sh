#!/bin/bash
# Deep Research E2E 测试脚本
#
# 用法: ./scripts/test-deep-research.sh [topic]
# 示例: ./scripts/test-deep-research.sh "AI Agent 框架对比"
#
# 功能:
#   1. 增量构建测试 bundle（仅源文件变化时重新构建）
#   2. 自动设置代理（国际 API 需要）
#   3. 运行 Deep Research E2E 测试并输出结构化报告
#
# 仅构建不运行: ./scripts/test-deep-research.sh --build-only

set -euo pipefail
cd "$(dirname "$0")/.."

TOPIC="${1:-MCP 协议最新进展}"
BUNDLE="dist/test-research.cjs"
ENTRY="scripts/_test-research-entry.ts"

# Externals — 与 package.json 中 build:main 保持一致
# Match build:test-runner externals from package.json exactly
# NOTE: electron-store is intentionally NOT external (must be bundled to avoid ESM require issues)
EXTERNALS=(
  electron better-sqlite3 keytar isolated-vm
  tree-sitter tree-sitter-typescript playwright playwright-core
  pptxgenjs mammoth exceljs qrcode pdfkit sharp docx node-pty @ui-tars/sdk
)

build_external_flags() {
  local flags=""
  for ext in "${EXTERNALS[@]}"; do
    flags="$flags --external:$ext"
  done
  echo "$flags"
}

# --- Step 1: Incremental build ---
needs_build=false

if [ ! -f "$BUNDLE" ]; then
  needs_build=true
elif [ "$ENTRY" -nt "$BUNDLE" ]; then
  needs_build=true
elif [ "scripts/_test-research-runner.cjs" -nt "$BUNDLE" ]; then
  needs_build=true
else
  # Check if any relevant source file is newer than bundle
  changed=$(find src/main/research src/main/model src/main/tools/toolExecutor.ts src/main/tools/toolRegistry.ts src/cli/electron-mock.ts src/main/services/core/configService.ts -newer "$BUNDLE" -name '*.ts' 2>/dev/null | head -1)
  if [ -n "$changed" ]; then
    needs_build=true
  fi
fi

if [ "$needs_build" = true ]; then
  echo "[build] Building test bundle..."
  # shellcheck disable=SC2046
  npx esbuild "$ENTRY" --bundle --platform=node --format=cjs \
    $(build_external_flags) \
    --outfile="$BUNDLE" --sourcemap 2>&1 | tail -5
  echo "[build] Done. $(wc -c < "$BUNDLE" | tr -d ' ') bytes"
else
  echo "[build] Using cached bundle ($(wc -c < "$BUNDLE" | tr -d ' ') bytes)."
fi

# --- Build-only mode ---
if [ "${1:-}" = "--build-only" ]; then
  echo "[build-only] Bundle ready at $BUNDLE"
  exit 0
fi

# --- Step 2: Run test ---
echo ""
echo "=== Deep Research E2E Test ==="
echo "Topic: $TOPIC"
echo ""

# CODE_AGENT_CLI_MODE=1 跳过 keytar 加载（keytar 的 native binding 在非 Electron 环境会 SIGSEGV）
CODE_AGENT_CLI_MODE=1 \
HTTPS_PROXY=http://127.0.0.1:7897 \
HTTP_PROXY=http://127.0.0.1:7897 \
  node scripts/_test-research-runner.cjs "$TOPIC"
