#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="${CODE_AGENT_GLINER_PII_CACHE:-$HOME/.cache/code-agent/gliner-pii}"
VENV_DIR="$CACHE_DIR/.venv"
MODEL_DIR="${CODE_AGENT_GLINER_PII_MODEL:-$CACHE_DIR/models/knowledgator-gliner-pii-base-v1.0}"
PYTHON_BIN="${CODE_AGENT_GLINER_PII_PYTHON:-}"
MODEL_REPO="knowledgator/gliner-pii-base-v1.0"
MODEL_BASE_URL="https://huggingface.co/$MODEL_REPO/resolve/main"

if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3.12 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3.12)"
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  else
    echo "python3.12 or python3 is required" >&2
    exit 1
  fi
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to create the isolated GLiNER environment" >&2
  exit 1
fi

mkdir -p "$MODEL_DIR/onnx"
uv venv --allow-existing --python "$PYTHON_BIN" "$VENV_DIR"
uv pip install --python "$VENV_DIR/bin/python" 'gliner==0.2.26' 'onnxruntime>=1.18,<2'

download_if_missing() {
  local remote_path="$1"
  local target="$2"
  if [[ -s "$target" ]]; then
    return
  fi
  mkdir -p "$(dirname "$target")"
  curl -L --fail --retry 3 --retry-delay 2 -o "$target" "$MODEL_BASE_URL/$remote_path"
}

download_if_missing "gliner_config.json" "$MODEL_DIR/gliner_config.json"
download_if_missing "tokenizer.json" "$MODEL_DIR/tokenizer.json"
download_if_missing "tokenizer_config.json" "$MODEL_DIR/tokenizer_config.json"
download_if_missing "special_tokens_map.json" "$MODEL_DIR/special_tokens_map.json"
download_if_missing "added_tokens.json" "$MODEL_DIR/added_tokens.json"
download_if_missing "spm.model" "$MODEL_DIR/spm.model"
download_if_missing "onnx/model.onnx" "$MODEL_DIR/onnx/model.onnx"

chmod +x "$ROOT_DIR/scripts/pii/gliner_onnx_runner.py"

cat <<EOF
GLiNER PII Base ONNX is ready.

export CODE_AGENT_PII_ENTITY_DETECTOR=gliner-onnx-command
export CODE_AGENT_GLINER_PII_COMMAND=$ROOT_DIR/scripts/pii/gliner_onnx_runner.py
export CODE_AGENT_GLINER_PII_RUNNER_PYTHON=$VENV_DIR/bin/python
export CODE_AGENT_GLINER_PII_MODEL=$MODEL_DIR
export CODE_AGENT_GLINER_PII_ONNX_FILE=onnx/model.onnx
export CODE_AGENT_PII_ENTITY_TIMEOUT_MS=30000

Smoke:
$ROOT_DIR/scripts/pii/smoke-gliner-pii.sh
EOF
