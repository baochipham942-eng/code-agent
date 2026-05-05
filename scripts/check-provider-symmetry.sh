#!/usr/bin/env bash
# =============================================================================
# check-provider-symmetry.sh — 检测 provider id 在三个锚点文件之间的对称性漂移
#
# 锚点：
#   1. src/shared/model-catalog.json        (catalog: provider 元数据真相源)
#   2. src/shared/constants/models.ts       (SUPPORTED_PROVIDERS: catalog 过滤白名单)
#   3. src/renderer/components/StatusBar/ModelSwitcher.tsx (QUICK_SWITCH_PROVIDERS: UI 快速切换)
#
# 不变量：
#   HARD  SUPPORTED \ catalog       = ∅   (否则 PROVIDER_MODELS.filter 得空)
#   HARD  QUICK_SWITCH \ SUPPORTED  = ∅   (否则 PROVIDER_MODELS_MAP[id] = undefined → UI 静默 fallback [])
#   WARN  catalog \ SUPPORTED      ≠ ∅   (catalog 多出来的 provider，可能漏加 SUPPORTED)
#
# 历史依据 (commit hash):
#   316184b4  fix(model): ModelSwitcher 漏加 xiaomi → catalog/SUPPORTED 已加但 QUICK_SWITCH 没加
#   65a20b5f  fix(model): unhide local provider     → catalog/QUICK_SWITCH 已加但 SUPPORTED 没加
#
# 用法:
#   bash scripts/check-provider-symmetry.sh           # 始终全量校验三个锚点
#   bash scripts/check-provider-symmetry.sh --quiet   # 通过时不输出（pre-commit 用）
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then
  QUIET=1
fi

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

CATALOG="src/shared/model-catalog.json"
CONSTANTS="src/shared/constants/models.ts"
SWITCHER="src/renderer/components/StatusBar/ModelSwitcher.tsx"

# --- 锚点存在性 ---
for f in "$CATALOG" "$CONSTANTS" "$SWITCHER"; do
  if [[ ! -f "$f" ]]; then
    echo -e "${RED}✗ 锚点文件丢失: $f${NC}" >&2
    echo -e "${YELLOW}如果是有意重构，请同步更新 scripts/check-provider-symmetry.sh${NC}" >&2
    exit 2
  fi
done

if ! command -v jq >/dev/null 2>&1; then
  echo -e "${RED}✗ 缺少 jq；macOS: brew install jq${NC}" >&2
  exit 2
fi

# --- 提取器 ---
extract_catalog() {
  jq -r '.providers[].id' "$CATALOG" | sort -u
}

# 从 marker 行起，到第一个含 ']' 的行止，提取所有单引号字符串
extract_const_array() {
  local file="$1" marker="$2"
  awk -v m="$marker" '
    $0 ~ m { in_block = 1 }
    in_block { print }
    in_block && /\]/ { exit }
  ' "$file" | grep -oE "'[^']+'" | tr -d "'" | sort -u
}

extract_supported() {
  extract_const_array "$CONSTANTS" "SUPPORTED_PROVIDERS = new Set"
}

extract_quick_switch() {
  extract_const_array "$SWITCHER" "QUICK_SWITCH_PROVIDERS = "
}

# --- 提取 + 非空校验 ---
catalog=$(extract_catalog)
supported=$(extract_supported)
quick_switch=$(extract_quick_switch)

if [[ -z "$catalog" || -z "$supported" || -z "$quick_switch" ]]; then
  echo -e "${RED}✗ 提取器返回空集；锚点文件结构可能已变化${NC}" >&2
  echo -e "  catalog:      $(echo "$catalog" | wc -l | xargs) ids" >&2
  echo -e "  SUPPORTED:    $(echo "$supported" | wc -l | xargs) ids" >&2
  echo -e "  QUICK_SWITCH: $(echo "$quick_switch" | wc -l | xargs) ids" >&2
  echo -e "${YELLOW}请检查 scripts/check-provider-symmetry.sh 的 marker / 提取逻辑${NC}" >&2
  exit 2
fi

# --- 集合差集 ---
s_minus_c=$(comm -23 <(echo "$supported") <(echo "$catalog") || true)
q_minus_s=$(comm -23 <(echo "$quick_switch") <(echo "$supported") || true)
c_minus_s=$(comm -23 <(echo "$catalog") <(echo "$supported") || true)

violations=0

if [[ -n "$s_minus_c" ]]; then
  echo -e "${RED}✗ HARD violation: SUPPORTED_PROVIDERS 含 catalog 没有的 provider${NC}"
  echo -e "  ${YELLOW}原因${NC}: PROVIDER_MODELS = catalog.providers.filter(p => SUPPORTED.has(p.id)) 会得空 → ghost provider"
  echo -e "  ${YELLOW}修法${NC}: 在 $CATALOG 补 provider 元数据，或从 $CONSTANTS 删除"
  echo "$s_minus_c" | sed 's/^/    - /'
  violations=$((violations+1))
  echo ""
fi

if [[ -n "$q_minus_s" ]]; then
  echo -e "${RED}✗ HARD violation: QUICK_SWITCH_PROVIDERS 含 SUPPORTED 没有的 provider${NC}"
  echo -e "  ${YELLOW}原因${NC}: PROVIDER_MODELS_MAP[id] = undefined → ModelSwitcher 静默 fallback [] (UI 看不到模型)"
  echo -e "  ${YELLOW}修法${NC}: 在 $CONSTANTS 的 SUPPORTED_PROVIDERS 加该 provider，或从 $SWITCHER 移除"
  echo "$q_minus_s" | sed 's/^/    - /'
  violations=$((violations+1))
  echo ""
fi

if [[ -n "$c_minus_s" && $QUIET -eq 0 ]]; then
  echo -e "${YELLOW}⚠ WARN: catalog 中有 provider 未暴露在 SUPPORTED_PROVIDERS${NC}"
  echo -e "  可能是有意 disable; 若是漏加，请在 $CONSTANTS 添加"
  echo "$c_minus_s" | sed 's/^/    - /'
  echo ""
fi

if [[ $violations -gt 0 ]]; then
  echo -e "${RED}provider 对称性检查发现 $violations 类硬违规${NC}" >&2
  echo -e "${YELLOW}详见 docs/audits/symmetric-application-guardrail.md${NC}" >&2
  exit 1
fi

if [[ $QUIET -eq 0 ]]; then
  echo -e "${GREEN}✓ provider 对称性检查通过${NC}"
  echo "  catalog $(echo "$catalog" | wc -l | xargs) / SUPPORTED $(echo "$supported" | wc -l | xargs) / QUICK_SWITCH $(echo "$quick_switch" | wc -l | xargs)"
fi
