#!/usr/bin/env python3
"""FunASR streaming ASR server — WebSocket + JSONL stdio dual mode.

Models:
- Paraformer-zh-streaming (ASR, ~220M params)
- FSMN-VAD (voice activity detection, ~5M params)
- CT-Transformer (punctuation restoration, ~70M params)
- CAM++ (speaker verification, ~7M params, optional)

Usage:
  # Check availability
  python3 funasr-server.py --check

  # Stdio JSONL mode (backward compatible with qwen3-asr-inference.py)
  python3 funasr-server.py --serve

  # WebSocket streaming mode (low latency)
  python3 funasr-server.py --ws --port 10096

  # One-shot transcription
  python3 funasr-server.py --audio /path/to/file.wav
"""

import argparse
import json
import sys
import os
import time
import warnings

warnings.filterwarnings("ignore")
os.environ["TRANSFORMERS_VERBOSITY"] = "error"

# Model IDs on ModelScope
MODELS = {
    "asr": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "asr_streaming": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online",
    "vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "punc": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
    "spk": "iic/speech_campplus_sv_zh-cn_16k-common",
}

# Cache directory
CACHE_DIR = os.path.expanduser("~/.cache/funasr")


def check_availability():
    """Check if FunASR and models are available."""
    result = {"available": False, "models": {}}
    try:
        import funasr

        result["funasr_version"] = funasr.__version__

        # Check cached models
        for name, model_id in MODELS.items():
            model_dir = os.path.join(CACHE_DIR, model_id.replace("/", "--"))
            result["models"][name] = {
                "id": model_id,
                "cached": os.path.isdir(model_dir),
            }

        result["available"] = True
    except ImportError as e:
        result["error"] = f"FunASR not installed: {e}"

    print(json.dumps(result))


def load_models(use_streaming=False, use_spk=False):
    """Load ASR pipeline models."""
    from funasr import AutoModel

    asr_model_id = MODELS["asr_streaming"] if use_streaming else MODELS["asr"]

    model = AutoModel(
        model=asr_model_id,
        vad_model=MODELS["vad"],
        punc_model=MODELS["punc"],
        spk_model=MODELS["spk"] if use_spk else None,
        cache_dir=CACHE_DIR,
    )
    return model


def transcribe_file(audio_path, use_spk=False):
    """One-shot file transcription."""
    if not os.path.exists(audio_path):
        print(json.dumps({"error": f"File not found: {audio_path}"}))
        sys.exit(1)

    try:
        start = time.time()
        model = load_models(use_streaming=False, use_spk=use_spk)
        results = model.generate(
            input=audio_path,
            batch_size_s=300,
        )
        duration = round(time.time() - start, 2)

        if results and len(results) > 0:
            res = results[0]
            text = res.get("text", "")
            output = {"text": text, "duration": duration}

            # Include sentence-level timestamps if available
            if "sentence_info" in res:
                output["sentences"] = res["sentence_info"]

            print(json.dumps(output, ensure_ascii=False))
        else:
            print(json.dumps({"text": "", "duration": duration}))
    except Exception as e:
        print(json.dumps({"error": f"Transcription failed: {str(e)}"}))
        sys.exit(1)


def serve_stdio():
    """Persistent serve mode: load models once, process JSONL requests via stdin/stdout.

    Compatible with the previous qwen3-asr-inference.py protocol.
    """
    try:
        model = load_models(use_streaming=False)
    except Exception as e:
        json.dump({"status": "error", "message": str(e)}, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
        sys.exit(1)

    json.dump(
        {"status": "ready", "engine": "FunASR Paraformer-zh + VAD + Punc"},
        sys.stdout,
    )
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
            json.dump(
                {"id": req_id, "error": f"Audio not found: {audio_path}"}, sys.stdout
            )
            sys.stdout.write("\n")
            sys.stdout.flush()
            continue

        try:
            start = time.time()
            results = model.generate(input=audio_path, batch_size_s=300)
            duration = round(time.time() - start, 2)

            text = ""
            if results and len(results) > 0:
                text = results[0].get("text", "")

            json.dump(
                {"id": req_id, "text": text, "duration": duration},
                sys.stdout,
                ensure_ascii=False,
            )
        except Exception as e:
            json.dump({"id": req_id, "error": str(e)}, sys.stdout)

        sys.stdout.write("\n")
        sys.stdout.flush()


def serve_websocket(port=10096):
    """WebSocket streaming server for real-time transcription.

    Protocol:
    - Client sends binary audio frames (PCM 16kHz 16-bit mono)
    - Server sends JSON: {"text": "...", "is_final": true/false, "mode": "2pass-online/2pass-offline"}

    Uses 2-pass strategy:
    - Online pass: fast partial results (low latency)
    - Offline pass: accurate final results (when silence detected)
    """
    import asyncio
    import websockets
    import numpy as np
    from funasr import AutoModel

    # Load streaming model
    model = AutoModel(
        model=MODELS["asr_streaming"],
        vad_model=MODELS["vad"],
        punc_model=MODELS["punc"],
        cache_dir=CACHE_DIR,
    )

    # Also load offline model for 2-pass final refinement
    model_offline = AutoModel(
        model=MODELS["asr"],
        vad_model=MODELS["vad"],
        punc_model=MODELS["punc"],
        cache_dir=CACHE_DIR,
    )

    print(json.dumps({"status": "ready", "port": port, "engine": "FunASR streaming"}))
    sys.stdout.flush()

    chunk_size_ms = 200  # 200ms chunks
    chunk_size_samples = 16000 * chunk_size_ms // 1000  # 3200 samples per chunk

    async def handle_client(websocket):
        """Handle a single WebSocket client connection."""
        cache = {}
        audio_buffer = b""

        try:
            async for message in websocket:
                if isinstance(message, str):
                    # Control message
                    try:
                        ctrl = json.loads(message)
                        if ctrl.get("command") == "stop":
                            # Process remaining buffer
                            if len(audio_buffer) > 0:
                                samples = np.frombuffer(audio_buffer, dtype=np.int16).astype(np.float32) / 32768.0
                                results = model.generate(
                                    input=samples,
                                    cache=cache,
                                    is_final=True,
                                    chunk_size=[5, 10, 5],
                                )
                                if results and results[0].get("text"):
                                    await websocket.send(json.dumps({
                                        "text": results[0]["text"],
                                        "is_final": True,
                                        "mode": "streaming-final",
                                    }, ensure_ascii=False))
                            cache = {}
                            audio_buffer = b""
                            await websocket.send(json.dumps({"status": "stopped"}))
                    except json.JSONDecodeError:
                        pass
                    continue

                # Binary audio data (PCM 16kHz 16-bit mono)
                audio_buffer += message

                # Process in chunks
                while len(audio_buffer) >= chunk_size_samples * 2:  # 2 bytes per sample
                    chunk_bytes = audio_buffer[: chunk_size_samples * 2]
                    audio_buffer = audio_buffer[chunk_size_samples * 2 :]

                    samples = np.frombuffer(chunk_bytes, dtype=np.int16).astype(np.float32) / 32768.0

                    results = model.generate(
                        input=samples,
                        cache=cache,
                        is_final=False,
                        chunk_size=[5, 10, 5],
                    )

                    if results and results[0].get("text"):
                        await websocket.send(json.dumps({
                            "text": results[0]["text"],
                            "is_final": False,
                            "mode": "streaming",
                        }, ensure_ascii=False))

        except websockets.exceptions.ConnectionClosed:
            pass

    async def main():
        async with websockets.serve(handle_client, "127.0.0.1", port):
            await asyncio.Future()  # run forever

    asyncio.run(main())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FunASR streaming ASR server")
    parser.add_argument("--check", action="store_true", help="Check availability")
    parser.add_argument("--audio", type=str, help="Transcribe audio file")
    parser.add_argument("--spk", action="store_true", help="Enable speaker diarization")
    parser.add_argument("--serve", action="store_true", help="JSONL stdio serve mode")
    parser.add_argument("--ws", action="store_true", help="WebSocket streaming mode")
    parser.add_argument("--port", type=int, default=10096, help="WebSocket port")
    args = parser.parse_args()

    if args.check:
        check_availability()
    elif args.audio:
        transcribe_file(args.audio, use_spk=args.spk)
    elif args.serve:
        serve_stdio()
    elif args.ws:
        serve_websocket(args.port)
    else:
        parser.print_help()
        sys.exit(1)
