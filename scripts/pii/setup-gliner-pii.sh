#!/usr/bin/env bash
# ============================================================================
# GLiNER PII 一键安装脚本 (B3 ootb 流程)
# ============================================================================
# 流程: 解析 uv binary -> 创建 venv -> 装 gliner+onnxruntime -> 下模型
#       -> 原子写入 ~/.code-agent/.env (替换已有 PII 配置, 保留其他 key)
#
# 调用方:
#   - dev: bash scripts/pii/setup-gliner-pii.sh
#   - packaged Neo IPC: 通过 env 传 CODE_AGENT_BUNDLED_UV / _RUNNER 指向
#                       Resources/_up_/scripts/ 下的路径
#
# 每步输出以 "▷ STEP: ..." 开头便于 IPC 流式解析。错误用 "❌" 开头。
# ============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="${CODE_AGENT_GLINER_PII_CACHE:-$HOME/.cache/code-agent/gliner-pii}"
VENV_DIR="$CACHE_DIR/.venv"
MODEL_DIR="${CODE_AGENT_GLINER_PII_MODEL:-$CACHE_DIR/models/knowledgator-gliner-pii-base-v1.0}"
ONNX_FILE="${CODE_AGENT_GLINER_PII_INSTALL_ONNX_FILE:-onnx/model_quint8.onnx}"
MODEL_REPO="knowledgator/gliner-pii-base-v1.0"
MODEL_BASE_URL="https://huggingface.co/$MODEL_REPO/resolve/main"
ENV_FILE="$HOME/.code-agent/.env"

# ---------------------------------------------------------------------------
# 解析 uv binary: bundled (IPC 传) > scripts/uv (dev) > system PATH
# ---------------------------------------------------------------------------
UV_BIN="${CODE_AGENT_BUNDLED_UV:-}"
if [[ -z "$UV_BIN" || ! -x "$UV_BIN" ]]; then
  UV_BIN="$ROOT_DIR/scripts/uv"
fi
if [[ ! -x "$UV_BIN" ]]; then
  if command -v uv >/dev/null 2>&1; then
    UV_BIN="$(command -v uv)"
  else
    echo "❌ 找不到 uv binary。运行 bash scripts/fetch-uv.sh 先拉取,或装系统 uv。" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 解析 runner: bundled (IPC 传) > scripts/pii/gliner_onnx_runner.py (dev)
# ---------------------------------------------------------------------------
RUNNER_PATH="${CODE_AGENT_BUNDLED_RUNNER:-$ROOT_DIR/scripts/pii/gliner_onnx_runner.py}"
if [[ ! -f "$RUNNER_PATH" ]]; then
  echo "❌ gliner_onnx_runner.py 缺失: $RUNNER_PATH" >&2
  exit 1
fi

echo "▷ STEP: 解析依赖 (uv=$UV_BIN, runner=$RUNNER_PATH)"

run_quiet() {
  local label="$1"
  shift
  local log_file
  log_file="$(mktemp "${TMPDIR:-/tmp}/code-agent-pii.XXXXXX")"
  if "$@" >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi
  local status=$?
  echo "❌ $label 失败" >&2
  tail -40 "$log_file" >&2 || true
  rm -f "$log_file"
  return "$status"
}

# ---------------------------------------------------------------------------
# 创建 venv (uv 自动管理 Python 3.12, 没装会自动下载)
# ---------------------------------------------------------------------------
mkdir -p "$MODEL_DIR/onnx"
echo "▷ STEP: 创建 Python 3.12 venv ($VENV_DIR)"
run_quiet "创建 Python 3.12 venv" "$UV_BIN" venv --allow-existing --python 3.12 "$VENV_DIR"

echo "▷ STEP: 安装 gliner + onnxruntime"
run_quiet "安装 gliner + onnxruntime" "$UV_BIN" pip install --python "$VENV_DIR/bin/python" 'gliner==0.2.26' 'onnxruntime>=1.18,<2'

# ---------------------------------------------------------------------------
# 下载模型文件 (HuggingFace, 默认 quint8 ONNX 约 190MB, 增量跳过已存在)
# ---------------------------------------------------------------------------
download_if_missing() {
  local remote_path="$1"
  local target="$2"
  if [[ -s "$target" ]]; then
    echo "▷ STEP: 模型分片已存在,跳过 ($(basename "$target"))"
    return
  fi
  echo "▷ STEP: 下载模型分片 $(basename "$target")"
  mkdir -p "$(dirname "$target")"
  local tmp_target="$target.tmp.$$"
  if curl --silent --show-error -L --fail --retry 3 --retry-delay 2 -o "$tmp_target" "$MODEL_BASE_URL/$remote_path"; then
    mv "$tmp_target" "$target"
    echo "✓ 下载完成 $(basename "$target")"
  else
    local status=$?
    rm -f "$tmp_target"
    return "$status"
  fi
}

download_if_missing "gliner_config.json" "$MODEL_DIR/gliner_config.json"
download_if_missing "tokenizer.json" "$MODEL_DIR/tokenizer.json"
download_if_missing "tokenizer_config.json" "$MODEL_DIR/tokenizer_config.json"
download_if_missing "special_tokens_map.json" "$MODEL_DIR/special_tokens_map.json"
download_if_missing "added_tokens.json" "$MODEL_DIR/added_tokens.json"
download_if_missing "spm.model" "$MODEL_DIR/spm.model"
download_if_missing "$ONNX_FILE" "$MODEL_DIR/$ONNX_FILE"

chmod +x "$RUNNER_PATH"

# ---------------------------------------------------------------------------
# 原子写入 ~/.code-agent/.env (替换已有 PII 配置, 保留其他 key)
# webServer 启动时会读这个文件,自动 export 到 Neo 主进程 env (见 CLAUDE.md)
# ---------------------------------------------------------------------------
echo "▷ STEP: 写入 $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
TMP_ENV="$ENV_FILE.tmp.$$"
{
  if [[ -f "$ENV_FILE" ]]; then
    grep -vE '^CODE_AGENT_(PII_ENTITY|GLINER_PII)' "$ENV_FILE" || true
  fi
  echo "CODE_AGENT_PII_ENTITY_DETECTOR=gliner-onnx-command"
  echo "CODE_AGENT_GLINER_PII_COMMAND=$RUNNER_PATH"
  echo "CODE_AGENT_GLINER_PII_RUNNER_PYTHON=$VENV_DIR/bin/python"
  echo "CODE_AGENT_GLINER_PII_MODEL=$MODEL_DIR"
  echo "CODE_AGENT_GLINER_PII_ONNX_FILE=$ONNX_FILE"
  echo "CODE_AGENT_PII_ENTITY_TIMEOUT_MS=30000"
} > "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"

echo "▷ STEP: 完成。重启 Neo 后本地 PII 防线生效。"
