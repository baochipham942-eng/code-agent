#!/usr/bin/env bash
# =============================================================================
# check-prompt-version-bump.sh — 改了系统提示词就必须 bump PROMPT_VERSION
#
# 背景：telemetry 用 PROMPT_VERSION 给每条 trace 打"第几版提示词"标签，从而能按
# promptVersion × errorType 聚合失败率。如果改了 prompt 却忘了 bump，归因就会把
# 两版提示词混成一版，诊断失真。本钩子在 pre-commit 拦下这种遗漏。
#
# 规则：本次 staged 改动里若有 src/main/prompts/ 下的文件，则 agent.ts 里的
# PROMPT_VERSION 常量值也必须在本次提交中变更，否则 fail。
#
# 用法：
#   bash scripts/check-prompt-version-bump.sh   # 检查 staged 文件（pre-commit）
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROMPTS_DIR="src/main/prompts/"
VERSION_FILE="src/shared/constants/agent.ts"

# staged 文件列表（含增/改/删/改名）
staged=$(git diff --cached --name-only --diff-filter=ACMRD)

# 是否动了 prompt 目录
prompt_changed=false
while IFS= read -r f; do
  case "$f" in
    "$PROMPTS_DIR"*) prompt_changed=true; break ;;
  esac
done <<< "$staged"

if [ "$prompt_changed" = false ]; then
  exit 0
fi

# 动了 prompt：检查 PROMPT_VERSION 是否在本次 staged 改动里变更
# 条件：agent.ts 的 staged diff 里出现新增的 PROMPT_VERSION 行
version_bumped=false
if echo "$staged" | grep -q "^${VERSION_FILE}$"; then
  if git diff --cached -- "$VERSION_FILE" | grep -qE '^\+export const PROMPT_VERSION'; then
    version_bumped=true
  fi
fi

if [ "$version_bumped" = true ]; then
  new_version=$(git diff --cached -- "$VERSION_FILE" | grep -E '^\+export const PROMPT_VERSION' | grep -oE "'[^']+'" | head -1)
  echo -e "${GREEN}✓ 检测到 prompt 改动，PROMPT_VERSION 已 bump 到 ${new_version}${NC}"
  exit 0
fi

echo -e "${RED}✗ 提交被拦下：改了 src/main/prompts/ 但没有 bump PROMPT_VERSION${NC}"
echo ""
echo -e "${YELLOW}本次涉及的 prompt 文件：${NC}"
echo "$staged" | grep "^${PROMPTS_DIR}" | sed 's/^/  /'
echo ""
echo -e "${YELLOW}请编辑 ${VERSION_FILE}，把 PROMPT_VERSION 递增（如 sys-v1 → sys-v2）后再提交。${NC}"
echo -e "${YELLOW}原因：telemetry 靠它按版本归因失败率，漏 bump 会让两版提示词混成一版、诊断失真。${NC}"
echo ""
echo -e "确实只是不影响提示词语义的改动（如纯注释）？可临时跳过：${YELLOW}git commit --no-verify${NC}"
exit 1
