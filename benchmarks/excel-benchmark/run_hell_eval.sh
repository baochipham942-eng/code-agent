#!/bin/bash
# ============================================================================
# Excel Benchmark HELL MODE - 5 个地狱难度 case
# ============================================================================
# 特点：大数据量(25K-50K行)、20+Sheet聚合、317行答案范围、复杂VBA逻辑
# Usage: bash eval/excel-benchmark/run_hell_eval.sh [case_number]
# ============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DATA_DIR="$PROJECT_DIR/eval/excel-benchmark/sample_data_200/spreadsheet"
RESULTS_DIR="$PROJECT_DIR/eval/excel-benchmark/results"
CLI="node $PROJECT_DIR/dist/cli/index.cjs"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$RESULTS_DIR/eval-hell-$TIMESTAMP.md"

mkdir -p "$RESULTS_DIR"

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Case definitions: id|setup_file|expected_keywords|prompt
declare -a CASES=(
  "532-3|1_532-3_input.xlsx|高亮 highlight 标记,Received,差异 difference|打开 test-bench.xlsx。该文件有两个 Sheet：第一个是原始数据，第二个(Received)包含手工更新的数据（部分已高亮标记变化）。需求：用 Python openpyxl 比较两个 Sheet，找出所有未被高亮标记的差异单元格，用新颜色（如红色）高亮这些遗漏的差异。已经正确高亮的不要改动。请直接修改 test-bench.xlsx。"
  "524-2|1_524-2_input.xlsx|PETITIONS,重复 duplicate 去重,删除 delete 行|打开 test-bench.xlsx。PETITIONS Sheet 有约 5881 行数据。需求：删除重复行——当 Petition、Parcel、Hearing Date 三列值相同时，保留 Hearing Date 最新的那行，删除较早的重复行。请用 Python openpyxl 实现，直接修改 test-bench.xlsx。注意数据量大，需要高效处理。"
  "374-9|1_374-9_input.xlsx|Sheet2,求和 sum 合计,total 总|打开 test-bench.xlsx。Sheet1 的第 6 行包含字母标记（A 或 B）。需求：遍历第 6 行，如果某列标记为 A，则将该列所有数值求和放入 Sheet2 的 B 列对应行；如果标记为 B，则求和放入 Sheet2 的 C 列。请用 Python openpyxl 实现，直接修改 test-bench.xlsx。"
  "110-6|1_110-6_input.xlsx|Calculation,Distribution,重复 repeat 次|打开 test-bench.xlsx。该文件有 Distribution 和 Calculation 两个 Sheet。需求：读取 Calculation!D7:D156 的文本和 X7:X156 的重复次数，将每个文本按指定次数重复写入 Calculation!DO14 开始的列。例如 D7='Apple' X7=3，则 DO14:DO16 都填 Apple。请用 Python openpyxl 实现。"
  "80-42|1_80-42_input.xlsx|Consolidate 合并,sheet,column 列|打开 test-bench.xlsx。该文件有 20+ 个数据 Sheet。需求：将所有数据 Sheet 的内容合并到一个名为 Consolidate_ALL 的新 Sheet 中。每行需要标明来源 Sheet 名称。只合并指定的列（不是全部列）。请用 Python openpyxl 先分析文件结构（所有 sheet 名和列结构），然后实现合并。"
)

CASE_FILTER="${1:-all}"

passed=0
failed=0
partial=0
total=0

echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  SpreadsheetBench HELL MODE (5 Hardest Cases)${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""

cat > "$REPORT_FILE" << 'HEADER'
# Excel AI Benchmark Results (HELL MODE)

| Case | ID | Difficulty | Status | Keywords Found | Duration |
|------|-----|-----------|--------|---------------|----------|
HEADER

for i in "${!CASES[@]}"; do
  case_num=$((i + 1))

  if [[ "$CASE_FILTER" != "all" ]] && [[ "$case_num" != "$CASE_FILTER" ]]; then
    continue
  fi

  IFS='|' read -r case_id setup_file expected_kw prompt <<< "${CASES[$i]}"

  total=$((total + 1))

  echo -e "${CYAN}── Case $case_num: $case_id (HELL) ──${NC}"

  # Setup: copy input file
  case_dir="$DATA_DIR/$case_id"
  work_file="$PROJECT_DIR/test-bench.xlsx"
  cp "$case_dir/$setup_file" "$work_file"

  # Run CA CLI with timeout (5 min for hell mode)
  start_time=$(date +%s)
  output_file="$RESULTS_DIR/hell-${case_id}-${TIMESTAMP}.txt"

  echo "   Running (5min timeout)..."
  set +e
  timeout 300 $CLI run \
    --provider moonshot --model kimi-k2.5 \
    --metrics "$RESULTS_DIR/metrics-hell-${case_id}-${TIMESTAMP}.json" \
    "$prompt" \
    > "$output_file" 2>&1
  exit_code=$?
  set -e

  end_time=$(date +%s)
  duration=$((end_time - start_time))

  # Check expected keywords (space-separated alternatives within each keyword group)
  IFS=',' read -ra keywords <<< "$expected_kw"
  found=0
  not_found=()
  for kw in "${keywords[@]}"; do
    # Convert spaces to grep -E alternation: "高亮 highlight 标记" → "高亮|highlight|标记"
    kw_pattern=$(echo "$kw" | sed 's/ /|/g')
    if grep -qiE "$kw_pattern" "$output_file" 2>/dev/null; then
      found=$((found + 1))
    else
      not_found+=("$kw")
    fi
  done

  kw_total=${#keywords[@]}
  kw_rate=$((found * 100 / kw_total))

  # Determine status
  if [[ $exit_code -ne 0 ]]; then
    status="ERROR"
    status_icon="${RED}❌${NC}"
    failed=$((failed + 1))
  elif [[ $found -eq $kw_total ]]; then
    status="PASS"
    status_icon="${GREEN}✅${NC}"
    passed=$((passed + 1))
  elif [[ $found -gt 0 ]]; then
    status="PARTIAL"
    status_icon="${YELLOW}🟡${NC}"
    partial=$((partial + 1))
  else
    status="FAIL"
    status_icon="${RED}❌${NC}"
    failed=$((failed + 1))
  fi

  echo -e "   $status_icon  Status: $status  |  Keywords: $found/$kw_total ($kw_rate%)  |  ${duration}s"
  if [[ ${#not_found[@]} -gt 0 ]]; then
    echo -e "   ${YELLOW}Missing: ${not_found[*]}${NC}"
  fi
  echo ""

  echo "| $case_num | $case_id | hell | $status | $found/$kw_total | ${duration}s |" >> "$REPORT_FILE"

  rm -f "$work_file"
done

echo -e "${BOLD}═══ Summary ═══${NC}"
echo -e "Total: $total  |  ${GREEN}Pass: $passed${NC}  |  ${YELLOW}Partial: $partial${NC}  |  ${RED}Fail: $failed${NC}"
if [[ $total -gt 0 ]]; then
  pass_rate=$((passed * 100 / total))
  echo -e "Pass Rate: ${pass_rate}%"
fi
echo ""
echo "Report: $REPORT_FILE"
echo "Detail logs: $RESULTS_DIR/hell-*-${TIMESTAMP}.txt"

cat >> "$REPORT_FILE" << EOF

## Summary

- **Total**: $total
- **Pass**: $passed
- **Partial**: $partial
- **Fail**: $failed
- **Pass Rate**: ${pass_rate:-0}%
- **Model**: moonshot/kimi-k2.5
- **Timeout**: 300s (5min)
- **Timestamp**: $TIMESTAMP
EOF
