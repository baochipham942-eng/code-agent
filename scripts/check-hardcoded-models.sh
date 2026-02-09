#!/usr/bin/env bash
# =============================================================================
# check-hardcoded-models.sh — 检测废弃模型名和禁止的 fallback 模式
#
# 用法：
#   bash scripts/check-hardcoded-models.sh          # 仅检查 staged 文件
#   bash scripts/check-hardcoded-models.sh --all    # 检查所有 .ts 文件
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 排除文件（常量来源 / 模型元数据来源 / 本脚本）
EXCLUDE_FILES=(
  "src/shared/constants.ts"
  "src/main/model/providerRegistry.ts"
  "scripts/check-hardcoded-models.sh"
)

# 废弃模型名（已被替换，不应出现在业务代码中）
DEPRECATED_PATTERNS=(
  "glm-4-flash"
  "glm-4v-plus"
  "glm-4v-flash"
  "glm-4-plus"
)

# moonshot-v1-8k 允许出现在 providerRegistry.ts 但不允许在其他文件
MOONSHOT_LEGACY="moonshot-v1-8k"

# 禁止的 fallback 模式
FORBIDDEN_FALLBACKS=(
  "|| 'deepseek'"
  "|| 'deepseek-chat'"
  "|| 'gen3'"
  "|| 'gen4'"
  "|| 'moonshot'"
  "|| 'kimi-k2.5'"
)

violations=0

# 构建 grep 排除参数
build_exclude_args() {
  local args=""
  for f in "${EXCLUDE_FILES[@]}"; do
    args="$args --exclude=$f"
  done
  echo "$args"
}

# 获取待检查文件列表
get_files() {
  if [[ "${1:-}" == "--all" ]]; then
    find src -name '*.ts' -not -path '*/node_modules/*' 2>/dev/null
  else
    git diff --cached --name-only --diff-filter=ACM 2>/dev/null | grep '\.ts$' || true
  fi
}

is_excluded() {
  local file="$1"
  for exc in "${EXCLUDE_FILES[@]}"; do
    if [[ "$file" == *"$exc" ]]; then
      return 0
    fi
  done
  return 1
}

check_pattern() {
  local pattern="$1"
  local label="$2"
  local files="$3"

  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    is_excluded "$file" && continue

    # 使用 grep -n 搜索匹配行
    local matches
    matches=$(grep -n "$pattern" "$file" 2>/dev/null || true)
    if [[ -n "$matches" ]]; then
      while IFS= read -r line; do
        echo -e "  ${RED}✗${NC} $file:$line"
        echo -e "    ${YELLOW}→ $label${NC}"
        ((violations++))
      done <<< "$matches"
    fi
  done <<< "$files"
}

# --- 主流程 ---

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

MODE="${1:-}"
FILES=$(get_files "$MODE")

if [[ -z "$FILES" ]]; then
  if [[ "$MODE" == "--all" ]]; then
    echo -e "${YELLOW}No .ts files found in src/${NC}"
  else
    echo -e "${GREEN}No staged .ts files to check${NC}"
  fi
  exit 0
fi

echo "=== 模型名称新鲜度检查 ==="
echo ""

# 1. 检查废弃模型名
echo "检查废弃模型名..."
for pattern in "${DEPRECATED_PATTERNS[@]}"; do
  check_pattern "$pattern" "废弃模型名: $pattern — 请使用 constants.ts 中的当前名称" "$FILES"
done

# 2. 检查 moonshot-v1-8k（排除 providerRegistry）
echo "检查遗留模型引用..."
check_pattern "$MOONSHOT_LEGACY" "遗留模型: $MOONSHOT_LEGACY — 非注册表场景不应直接引用" "$FILES"

# 3. 检查禁止的 fallback
echo "检查禁止的 fallback 模式..."
for pattern in "${FORBIDDEN_FALLBACKS[@]}"; do
  check_pattern "$pattern" "禁止 fallback: $pattern — 请使用 DEFAULT_PROVIDER/DEFAULT_MODEL/DEFAULT_GENERATION" "$FILES"
done

echo ""
if [[ $violations -gt 0 ]]; then
  echo -e "${RED}发现 $violations 处违规${NC}"
  echo -e "请参考 src/shared/constants.ts 获取正确的常量名称"
  exit 1
else
  echo -e "${GREEN}✓ 检查通过，无违规${NC}"
  exit 0
fi
