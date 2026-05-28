#!/usr/bin/env python3
"""Local GLiNER PII ONNX runner.

Reads a JSON request from stdin and writes:
  {"entities": [{"start": 0, "end": 5, "label": "person", "score": 0.91}]}

The TypeScript Sensitive Data Guard invokes this as an opt-in command provider.
"""

from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any


DEFAULT_MODEL_DIR = (
    Path.home()
    / ".cache"
    / "code-agent"
    / "gliner-pii"
    / "models"
    / "knowledgator-gliner-pii-base-v1.0"
)
DEFAULT_ONNX_FILE = "onnx/model_quint8.onnx"


def main() -> int:
    try:
        request = json.load(sys.stdin)
        text = str(request.get("text") or "")
        labels = request.get("labels") or []
        threshold = float(request.get("threshold") or 0.5)
        model_path = str(
            request.get("modelPath")
            or os.environ.get("CODE_AGENT_GLINER_PII_MODEL")
            or DEFAULT_MODEL_DIR
        )
        onnx_file = str(
            request.get("onnxModelFile")
            or os.environ.get("CODE_AGENT_GLINER_PII_ONNX_FILE")
            or DEFAULT_ONNX_FILE
        )

        if not text.strip() or not labels:
            print(json.dumps({"entities": []}, ensure_ascii=False))
            return 0

        model = load_model(model_path, onnx_file)
        raw_entities = model.predict_entities(text, labels, threshold=threshold)
        entities = [normalize_entity(entity, text) for entity in raw_entities]
        entities = [entity for entity in entities if entity is not None]

        print(json.dumps({"entities": entities}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


@lru_cache(maxsize=2)
def load_model(model_path: str, onnx_file: str):
    from gliner import GLiNER

    path = Path(model_path).expanduser()
    if path.exists() and not (path / onnx_file).exists():
        raise FileNotFoundError(f"ONNX model file not found: {path / onnx_file}")

    return GLiNER.from_pretrained(
        str(path if path.exists() else model_path),
        load_onnx_model=True,
        onnx_model_file=onnx_file,
    )


def normalize_entity(entity: dict[str, Any], text: str) -> dict[str, Any] | None:
    start = entity.get("start")
    end = entity.get("end")
    label = entity.get("label")
    if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end <= start:
        return None
    if end > len(text):
        return None
    return {
        "start": start,
        "end": end,
        "label": str(label or "entity"),
        "score": float(entity.get("score") or 0.0),
        "text": text[start:end],
    }


if __name__ == "__main__":
    raise SystemExit(main())
