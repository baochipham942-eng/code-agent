#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="${CODE_AGENT_GLINER_PII_CACHE:-$HOME/.cache/code-agent/gliner-pii}"
MODEL_DIR="${CODE_AGENT_GLINER_PII_MODEL:-$CACHE_DIR/models/knowledgator-gliner-pii-base-v1.0}"
PYTHON_BIN="${CODE_AGENT_GLINER_PII_RUNNER_PYTHON:-$CACHE_DIR/.venv/bin/python}"
RUNNER="$ROOT_DIR/scripts/pii/gliner_onnx_runner.py"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Missing GLiNER Python environment: $PYTHON_BIN" >&2
  echo "Run: $ROOT_DIR/scripts/pii/setup-gliner-pii.sh" >&2
  exit 1
fi

if [[ ! -s "$MODEL_DIR/onnx/model.onnx" ]]; then
  echo "Missing GLiNER ONNX model: $MODEL_DIR/onnx/model.onnx" >&2
  echo "Run: $ROOT_DIR/scripts/pii/setup-gliner-pii.sh" >&2
  exit 1
fi

REQUEST='{
  "text": "Alice Zhang lives in Shanghai. Her phone number is +1 415 555 1212 and her email is alice@example.com.",
  "labels": ["person", "location", "phone number", "email", "address", "organization"],
  "threshold": 0.3,
  "modelPath": "'"$MODEL_DIR"'",
  "surface": "export",
  "mode": "share"
}'

echo "$REQUEST" | "$PYTHON_BIN" "$RUNNER"
