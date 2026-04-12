#!/bin/bash
# ============================================================================
# Circular Dependency Check
# 用 madge 扫描 src/main，循环依赖数超过 baseline 即阻断。
#
# Baseline: 4 条（2026-04 protocol 层迁移后实测）
# 当前允许值: MAX_CIRCULAR
#
# 本地安装到 git hooks:
#   echo 'bash scripts/check-circular-deps.sh || exit 1' >> .git/hooks/pre-commit
# ============================================================================

set -e

MAX_CIRCULAR=4
SCAN_ROOT="src/main"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 只在改动涉及 src/main 时才跑（加速非后端改动的 commit）
if git rev-parse --git-dir > /dev/null 2>&1; then
  STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep -E "^${SCAN_ROOT}/.+\.tsx?$" || true)
  if [ -z "$STAGED" ]; then
    exit 0
  fi
fi

# 运行 madge
OUTPUT=$(npx --no-install madge --ts-config tsconfig.json --extensions ts,tsx --circular "$SCAN_ROOT" 2>&1 || true)

# 解析循环依赖数
CIRC_COUNT=$(echo "$OUTPUT" | grep -oE "Found [0-9]+ circular dependencies" | grep -oE "[0-9]+" || echo "0")

if [ -z "$CIRC_COUNT" ]; then
  CIRC_COUNT=0
fi

if [ "$CIRC_COUNT" -gt "$MAX_CIRCULAR" ]; then
  echo ""
  echo -e "${RED}============================================${NC}"
  echo -e "${RED}  CIRCULAR DEPENDENCY REGRESSION - BLOCKED${NC}"
  echo -e "${RED}============================================${NC}"
  echo ""
  echo -e "baseline: ${GREEN}${MAX_CIRCULAR}${NC} 条"
  echo -e "current:  ${RED}${CIRC_COUNT}${NC} 条"
  echo ""
  echo "$OUTPUT" | tail -30
  echo ""
  echo -e "${YELLOW}修复建议:${NC}"
  echo "  1. 新增的循环请先抽象到 src/main/protocol/"
  echo "  2. 确实需要强合入，用: git commit --no-verify"
  echo "  3. 如果降低了循环数，请同步更新本脚本的 MAX_CIRCULAR"
  echo ""
  exit 1
fi

if [ "$CIRC_COUNT" -lt "$MAX_CIRCULAR" ]; then
  echo -e "${GREEN}[madge]${NC} circular deps: ${CIRC_COUNT}/${MAX_CIRCULAR} — consider lowering MAX_CIRCULAR in scripts/check-circular-deps.sh"
else
  echo -e "${GREEN}[madge]${NC} circular deps: ${CIRC_COUNT}/${MAX_CIRCULAR} ✓"
fi

exit 0
