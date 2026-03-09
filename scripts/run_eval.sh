#!/bin/bash
# ============================================================================
# run_eval.sh — 评测运行脚本
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 默认参数
SCOPE="smoke"
MODEL=""
REAL_MODE=""
CONCURRENCY=""

# 解析参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --scope) SCOPE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --real) REAL_MODE="--real"; shift ;;
    --concurrency) CONCURRENCY="--concurrency $2"; shift 2 ;;
    --promote) cd "$PROJECT_DIR" && npx tsx "$SCRIPT_DIR/eval-ci.ts" --promote; exit 0 ;;
    --trend) cd "$PROJECT_DIR" && npx tsx "$SCRIPT_DIR/eval-ci.ts" --trend; exit 0 ;;
    --help|-h)
      echo "用法: run_eval.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --scope <smoke|core|full>  评测范围 (默认: smoke)"
      echo "  --model <model-name>       指定模型"
      echo "  --real                     使用真实模型 (默认: mock)"
      echo "  --concurrency <n>          并发数"
      echo "  --promote                  提升当前结果为基线"
      echo "  --trend                    显示趋势"
      echo "  --help                     显示帮助"
      exit 0
      ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

cd "$PROJECT_DIR"

echo "=== 评测配置 ==="
echo "范围: $SCOPE"
echo "模式: ${REAL_MODE:-mock}"
[[ -n "$MODEL" ]] && echo "模型: $MODEL"
echo ""

# 构建命令
CMD="npx tsx scripts/eval-ci.ts --scope $SCOPE $REAL_MODE $CONCURRENCY"
[[ -n "$MODEL" ]] && CMD="$CMD --model $MODEL"

echo "执行: $CMD"
echo "---"
eval "$CMD"
