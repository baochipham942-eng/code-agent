#!/bin/bash
# ============================================================================
# Excel Benchmark CLI Eval - 用 CA CLI 的 run 命令逐个跑 10 个 case
# ============================================================================
# Usage: bash eval/excel-benchmark/run_cli_eval.sh [case_number]
#   无参数: 跑全部 10 个
#   指定数字: 只跑该 case (1-10)
# ============================================================================

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BENCHMARK_DIR="$PROJECT_DIR/eval/excel-benchmark/selected_10"
RESULTS_DIR="$PROJECT_DIR/eval/excel-benchmark/results"
CLI="node $PROJECT_DIR/dist/cli/index.cjs"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
REPORT_FILE="$RESULTS_DIR/eval-cli-$TIMESTAMP.md"

mkdir -p "$RESULTS_DIR"

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Case definitions: id|type|difficulty|setup_file|expected_keywords|prompt
# Using | as delimiter
declare -a CASES=(
  "59196|Cell|medium|1_59196_input.xlsx|D,A|打开 test-bench.xlsx。我需要一个公式，在 H 列(H3:H5)中，找出每一行中数值最大的列，并返回该列的标题。请直接修改 test-bench.xlsx，在 H3:H5 填入公式或结果值。预期答案：H3=D, H4=A, H5=D。用 Python openpyxl 实现。"
  "CF_28766|Sheet|hard|1_CF_28766_input.xlsx|duplicate 重复 去重,COUNTIF 条件 计数,高亮 highlight 标记|打开 test-bench.xlsx。Sheet1 的 C:G 列包含日期和人名数据。需求：创建条件格式规则，仅标记同一天内第二次及后续出现的名字（用黄色高亮）。第一次出现不标记。请用 Python openpyxl 实现，修改 test-bench.xlsx，目标范围 C3:G14。"
  "382-29|Sheet|hard|1_382-29_input.xlsx|42,36,18|打开 test-bench.xlsx。该文件有 4 个 Sheet：3 个数据表 + 1 个 Totals 表。需求：将所有数据表的 B2:B26 对应单元格求和，填入 Totals!B2:B26。例如 Totals!B2 = Sheet1!B2 + Sheet2!B2 + Sheet3!B2。请用 Python openpyxl 实现，直接修改 test-bench.xlsx。预期答案示例：B2=42, B3=36, B4=18。"
  "66-1|Sheet|hard|1_66-1_input.xlsx|2.4,2,3|打开 test-bench.xlsx。Sheet1 中产品描述末尾包含宽度和高度尺寸（如 300x800）。需求：在 E 列(E2:E11)计算每个产品的面积（平方米 m2），公式 = 宽x高/1000000。请用 Python openpyxl 实现，读取描述中的尺寸数字，计算面积并填入 E 列。预期答案示例：E2=2.4, E3=2, E4=3。"
  "353-50|Sheet|hard|1_353-50_input.xlsx|column,month,October|打开 test-bench.xlsx。需求：在 Sheet1 中插入一个新列，对应当前日期的上一个月。例如如果现在是 11 月，则插入 October 列。同时将前一个月的数据和公式复制到新列中。请用 Python openpyxl 分析文件结构然后实现。"
  "91-3|Sheet|hard|1_91-3_input.xlsx|PURCHASE,SALES,BALANCE|打开 test-bench.xlsx。该文件有多个 Sheet，每个 Sheet 的 B 列包含词条，C/D 列有金额。需求：在 FINAL sheet 中，A 列列出 sheet 名，B:H 列的表头基于各 sheet B 列内容生成，同一 sheet 内重复词条合并求和。请用 Python openpyxl 实现。预期表头示例：TRANSFERRING BALANCE, PURCHASE, SALES。"
  "46167|Cell|easy|1_46167_input.xlsx|270,SUMIF|打开 test-bench.xlsx。A 列是 PRODUCT ID，B 列是 QTY（数量）。需求：在 D2 单元格创建一个 SUMIF 公式或直接计算，求 PRODUCT ID 为 111111 的所有 QTY 之和。预期结果：D2 = 270（来自 50+60+70+90）。请用 Python openpyxl 实现，直接修改 test-bench.xlsx。"
  "58994|Cell|medium|1_58994_input.xlsx|750|打开 test-bench.xlsx。数据格式为 What:Who-Size-SKU（例如 FG:BJ-155-00310）。需求：提取 Size 部分并转换为容量。在 Sheet1!F8 单元格输出结果。请用 Python 或公式实现。预期答案：F8 = 750ml。"
  "55427|Cell|hard|1_55427_input.xlsx|INDEX,MATCH,2002|打开 test-bench.xlsx。该文件有多个 Sheet，包含学校数据。需求：在 Compiled and located schools da Sheet 的 B 列(B2起)，使用逻辑等同于 INDEX/MATCH 的方式从 URN lookup Sheet 中查找 DFES number。匹配：用 L 列在 URN lookup!K 列中查找，返回 D 列的值。请用 Python openpyxl 实现。预期 B2=2002。"
  "44389|Cell|hard|1_44389_input.xlsx|MMX,KWH,Catch|打开 test-bench.xlsx。数据区域有多列数值，P 列(P2:P7)需要显示每行中大于零的最小值所在的列标题。如果有多个列的值相同且都是最小值，则用逗号分隔，例如 KWH,VB。请用 Python openpyxl 实现，直接修改 test-bench.xlsx。预期答案示例：P2=MMX, P3=Catch, P4=KWH,VB。"
)

# Parse optional case number
CASE_FILTER="${1:-all}"

passed=0
failed=0
partial=0
total=0

echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  SpreadsheetBench Excel AI Eval (CA CLI Real Mode)${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""

# Write report header
cat > "$REPORT_FILE" << 'HEADER'
# Excel AI Benchmark Results

| Case | ID | Type | Difficulty | Status | Keywords Found | Duration |
|------|-----|------|-----------|--------|---------------|----------|
HEADER

for i in "${!CASES[@]}"; do
  case_num=$((i + 1))

  # Skip if specific case requested
  if [[ "$CASE_FILTER" != "all" ]] && [[ "$case_num" != "$CASE_FILTER" ]]; then
    continue
  fi

  IFS='|' read -r case_id case_type difficulty setup_file expected_kw prompt <<< "${CASES[$i]}"

  total=$((total + 1))

  echo -e "${CYAN}── Case $case_num: $case_id ($case_type, $difficulty) ──${NC}"

  # Setup: copy input file
  case_dir="$BENCHMARK_DIR/$case_id"
  work_file="$PROJECT_DIR/test-bench.xlsx"
  cp "$case_dir/$setup_file" "$work_file"

  # Run CA CLI with timeout (3 min)
  start_time=$(date +%s)
  output_file="$RESULTS_DIR/case-${case_id}-${TIMESTAMP}.txt"

  echo "   Running..."
  set +e
  timeout 180 $CLI run \
    --provider moonshot --model kimi-k2.5 \
    --metrics "$RESULTS_DIR/metrics-${case_id}-${TIMESTAMP}.json" \
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

  # Append to report
  echo "| $case_num | $case_id | $case_type | $difficulty | $status | $found/$kw_total | ${duration}s |" >> "$REPORT_FILE"

  # Cleanup
  rm -f "$work_file"
done

# Summary
echo -e "${BOLD}═══ Summary ═══${NC}"
echo -e "Total: $total  |  ${GREEN}Pass: $passed${NC}  |  ${YELLOW}Partial: $partial${NC}  |  ${RED}Fail: $failed${NC}"
pass_rate=$((passed * 100 / total))
echo -e "Pass Rate: ${pass_rate}%"
echo ""
echo "Report: $REPORT_FILE"
echo "Detail logs: $RESULTS_DIR/case-*-${TIMESTAMP}.txt"

# Append summary to report
cat >> "$REPORT_FILE" << EOF

## Summary

- **Total**: $total
- **Pass**: $passed
- **Partial**: $partial
- **Fail**: $failed
- **Pass Rate**: ${pass_rate}%
- **Model**: moonshot/kimi-k2.5
- **Timestamp**: $TIMESTAMP
EOF
