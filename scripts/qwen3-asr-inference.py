#!/usr/bin/env python3
"""Qwen3-ASR local inference script using official qwen-asr package."""
import argparse, json, sys, os, time, warnings

# Suppress warnings
warnings.filterwarnings("ignore")
os.environ["TRANSFORMERS_VERBOSITY"] = "error"


def find_model_path():
    """Search for Qwen3-ASR model in known locations."""
    # ASRO directory (direct path)
    asro_path = os.path.expanduser(
        "~/Library/Application Support/net.bytenote.asro/models/qwen3-asr-0.6b"
    )
    if os.path.isdir(asro_path) and os.path.exists(
        os.path.join(asro_path, "model.safetensors")
    ):
        return asro_path

    # HF cache
    hf_base = os.path.expanduser(
        "~/.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots"
    )
    if os.path.isdir(hf_base):
        versions = sorted(os.listdir(hf_base))
        if versions:
            return os.path.join(hf_base, versions[-1])

    return None


def check_availability():
    model_path = find_model_path()
    print(
        json.dumps(
            {
                "available": model_path is not None,
                "model_path": model_path,
                "model_size": "0.6b",
            }
        )
    )


def transcribe(audio_path, model_size="0.6b"):
    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except ImportError as e:
        print(
            json.dumps(
                {
                    "error": f"Missing dependency: {e}. Install with: pip install qwen-asr torch"
                }
            )
        )
        sys.exit(1)

    model_path = find_model_path()
    if not model_path:
        print(
            json.dumps(
                {"error": "Model not found. Download via ASRO or huggingface-cli."}
            )
        )
        sys.exit(1)

    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"Audio file not found: {audio_path}"}))
        sys.exit(1)

    try:
        start = time.time()
        model = Qwen3ASRModel.from_pretrained(
            model_path, dtype=torch.float32, device_map="cpu"
        )
        results = model.transcribe(audio_path)
        duration = round(time.time() - start, 2)

        text = results[0].text if results else ""
        print(json.dumps({"text": text, "duration": duration}))
    except Exception as e:
        print(json.dumps({"error": f"Transcription failed: {str(e)}"}))
        sys.exit(1)


def serve():
    """Persistent serve mode: load model once, process requests via stdin JSONL."""
    try:
        import torch
        from qwen_asr import Qwen3ASRModel
    except ImportError as e:
        json.dump({"status": "error", "message": f"Missing dependency: {e}"}, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
        sys.exit(1)

    model_path = find_model_path()
    if not model_path:
        json.dump({"status": "error", "message": "Model not found"}, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
        sys.exit(1)

    model = Qwen3ASRModel.from_pretrained(model_path, dtype=torch.float32, device_map="cpu")
    json.dump({"status": "ready", "model_path": model_path}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue

        if req.get("command") == "quit":
            json.dump({"status": "shutdown"}, sys.stdout)
            sys.stdout.write("\n")
            sys.stdout.flush()
            break

        req_id = req.get("id", "")
        audio_path = req.get("audio_path", "")
        if not audio_path or not os.path.exists(audio_path):
            json.dump({"id": req_id, "error": f"Audio not found: {audio_path}"}, sys.stdout)
            sys.stdout.write("\n")
            sys.stdout.flush()
            continue

        try:
            start = time.time()
            results = model.transcribe(audio_path)
            duration = round(time.time() - start, 2)
            text = results[0].text if results else ""
            json.dump({"id": req_id, "text": text, "duration": duration}, sys.stdout)
        except Exception as e:
            json.dump({"id": req_id, "error": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Qwen3-ASR inference")
    parser.add_argument(
        "--check", action="store_true", help="Check model availability"
    )
    parser.add_argument("--audio", type=str, help="Path to audio file")
    parser.add_argument("--model", type=str, default="0.6b", help="Model size")
    parser.add_argument(
        "--serve", action="store_true", help="Persistent serve mode (JSONL over stdio)"
    )
    args = parser.parse_args()

    if args.serve:
        serve()
    elif args.check:
        check_availability()
    elif args.audio:
        transcribe(args.audio, args.model)
    else:
        parser.print_help()
        sys.exit(1)
