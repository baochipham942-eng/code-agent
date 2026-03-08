#!/usr/bin/env python3
"""Real-time meeting transcription CLI tool.

Architecture: Mic PCM → Silero VAD → sentence segmentation → Qwen3-ASR → print + save

Usage:
  python3 demo-meeting-asr.py                        # Transcribe and save
  python3 demo-meeting-asr.py --output meeting.json   # Custom output path
  python3 demo-meeting-asr.py --vad-only              # Only VAD (no ASR, fast test)
  python3 demo-meeting-asr.py --list                  # List audio devices

Output formats (auto-detected by extension):
  .json  — structured segments with timestamps
  .txt   — plain text transcript
  .srt   — subtitle format
"""

import argparse
import json
import os
import sys
import time
import threading
import queue
import warnings
import tempfile
import wave

import numpy as np
import sounddevice as sd

warnings.filterwarnings("ignore")
os.environ["TRANSFORMERS_VERBOSITY"] = "error"

# ============================================================================
# Config
# ============================================================================

SAMPLE_RATE = 16000           # 16kHz for ASR
CHANNELS = 1                  # Mono
DTYPE = "int16"               # 16-bit PCM
BLOCK_SIZE = 512              # Samples per callback (~32ms at 16kHz)

# VAD parameters (tuned for meeting scenario)
VAD_THRESHOLD = 0.45          # Speech probability threshold
MIN_SPEECH_MS = 500           # Ignore speech segments < 500ms
MIN_SILENCE_MS = 600          # 600ms silence = sentence boundary
SPEECH_PAD_MS = 150           # Pad speech segments by 150ms each side
MAX_SPEECH_S = 15.0           # Force-split speech segments > 15s

# Speaker diarization (Phase 2, simple cosine clustering)
SPEAKER_THRESHOLD = 0.70      # Cosine similarity threshold for same speaker

# ============================================================================
# Color output
# ============================================================================

class C:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    CYAN = "\033[36m"
    RED = "\033[31m"
    MAGENTA = "\033[35m"

SPEAKER_COLORS = [C.CYAN, C.GREEN, C.MAGENTA, C.YELLOW, C.RED]

def color_speaker(speaker_id):
    return SPEAKER_COLORS[(speaker_id - 1) % len(SPEAKER_COLORS)]

# ============================================================================
# VAD Engine (Silero)
# ============================================================================

class VadEngine:
    """Silero VAD wrapper with state machine for sentence boundary detection."""

    def __init__(self):
        from silero_vad import load_silero_vad
        self.model = load_silero_vad()
        self.reset()

    def reset(self):
        self.model.reset_states()
        self._speech_active = False
        self._speech_buffer = []         # PCM samples of current speech segment
        self._silence_samples = 0        # Consecutive silence sample count
        self._speech_samples = 0         # Current speech segment sample count
        self._pending_pad = []           # Pre-speech padding buffer

        # Derived thresholds (in samples)
        self._min_speech_samples = int(MIN_SPEECH_MS * SAMPLE_RATE / 1000)
        self._min_silence_samples = int(MIN_SILENCE_MS * SAMPLE_RATE / 1000)
        self._speech_pad_samples = int(SPEECH_PAD_MS * SAMPLE_RATE / 1000)
        self._max_speech_samples = int(MAX_SPEECH_S * SAMPLE_RATE)

    def process_chunk(self, pcm_int16: np.ndarray) -> list:
        """Process a PCM chunk, return list of completed speech segments (numpy arrays).

        Each returned segment is a complete sentence's worth of audio.
        """
        import torch

        # Convert to float32 for Silero
        pcm_float = pcm_int16.astype(np.float32) / 32768.0
        tensor = torch.from_numpy(pcm_float)

        # Get speech probability
        prob = self.model(tensor, SAMPLE_RATE).item()

        completed = []

        if prob >= VAD_THRESHOLD:
            # Speech detected
            if not self._speech_active:
                # Speech onset
                self._speech_active = True
                self._speech_buffer = list(self._pending_pad)  # Include pre-pad
                self._silence_samples = 0
                self._speech_samples = len(self._speech_buffer)

            self._speech_buffer.extend(pcm_int16.tolist())
            self._speech_samples += len(pcm_int16)
            self._silence_samples = 0

            # Force-split if too long
            if self._speech_samples >= self._max_speech_samples:
                segment = np.array(self._speech_buffer, dtype=np.int16)
                completed.append(segment)
                self._speech_buffer = []
                self._speech_samples = 0

        else:
            # Silence / noise
            if self._speech_active:
                # Add to buffer (hangover)
                self._speech_buffer.extend(pcm_int16.tolist())
                self._silence_samples += len(pcm_int16)

                if self._silence_samples >= self._min_silence_samples:
                    # Sentence boundary confirmed
                    if self._speech_samples >= self._min_speech_samples:
                        segment = np.array(self._speech_buffer, dtype=np.int16)
                        completed.append(segment)
                    # else: too short, discard (noise/cough)

                    self._speech_active = False
                    self._speech_buffer = []
                    self._speech_samples = 0
                    self._silence_samples = 0

        # Maintain pre-speech padding buffer
        self._pending_pad = pcm_int16.tolist()[-self._speech_pad_samples:]

        return completed

    @property
    def is_speaking(self):
        return self._speech_active

# ============================================================================
# ASR Engine (Qwen3-ASR)
# ============================================================================

class AsrEngine:
    """Qwen3-ASR wrapper for offline transcription of speech segments."""

    def __init__(self, model_path: str):
        import torch
        from qwen_asr import Qwen3ASRModel

        print(f"{C.DIM}Loading Qwen3-ASR model from {model_path}...{C.RESET}")
        start = time.time()
        self.model = Qwen3ASRModel.from_pretrained(
            model_path, dtype=torch.float32, device_map="cpu"
        )
        elapsed = round(time.time() - start, 1)
        print(f"{C.GREEN}Qwen3-ASR loaded in {elapsed}s{C.RESET}")

    def transcribe(self, pcm_int16: np.ndarray) -> str:
        """Transcribe a PCM int16 numpy array, return text."""
        # Write to temp WAV file (Qwen3-ASR expects file path)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp_path = f.name
            with wave.open(f, "wb") as wf:
                wf.setnchannels(CHANNELS)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes(pcm_int16.tobytes())

        try:
            results = self.model.transcribe(tmp_path)
            if results and len(results) > 0:
                return results[0].text.strip()
            return ""
        finally:
            os.unlink(tmp_path)

# ============================================================================
# Speaker Tracker (simple cosine clustering)
# ============================================================================

class SpeakerTracker:
    """Simple online speaker identification using embedding cosine similarity."""

    def __init__(self, threshold=SPEAKER_THRESHOLD):
        self.threshold = threshold
        self.speakers = {}  # id → {'centroid': np.array, 'count': int}
        self.next_id = 1
        self.encoder = None
        self._available = False

    def try_init(self):
        """Try to load speaker embedding model. Non-fatal if unavailable."""
        try:
            from speechbrain.inference import EncoderClassifier
            self.encoder = EncoderClassifier.from_hparams(
                source="speechbrain/spkrec-ecapa-voxceleb",
                run_opts={"device": "cpu"},
            )
            self._available = True
            print(f"{C.GREEN}Speaker embedding model loaded (ECAPA-TDNN){C.RESET}")
        except Exception as e:
            print(f"{C.YELLOW}Speaker diarization unavailable: {e}{C.RESET}")
            self._available = False

    @property
    def available(self):
        return self._available

    def identify(self, pcm_int16: np.ndarray) -> int:
        """Return speaker ID for this audio segment."""
        if not self._available:
            return 0

        import torch
        # Min 1s for reliable embedding
        if len(pcm_int16) < SAMPLE_RATE:
            return 0

        pcm_float = pcm_int16.astype(np.float32) / 32768.0
        tensor = torch.from_numpy(pcm_float).unsqueeze(0)
        embedding = self.encoder.encode_batch(tensor).squeeze().numpy()

        if not self.speakers:
            self.speakers[1] = {"centroid": embedding, "count": 1}
            self.next_id = 2
            return 1

        # Find best match
        best_id, best_sim = None, -1.0
        for spk_id, profile in self.speakers.items():
            sim = np.dot(embedding, profile["centroid"]) / (
                np.linalg.norm(embedding) * np.linalg.norm(profile["centroid"])
            )
            if sim > best_sim:
                best_sim = sim
                best_id = spk_id

        if best_sim >= self.threshold:
            # Update centroid (moving average)
            p = self.speakers[best_id]
            n = p["count"]
            p["centroid"] = (p["centroid"] * n + embedding) / (n + 1)
            p["count"] = n + 1
            return best_id
        else:
            new_id = self.next_id
            self.speakers[new_id] = {"centroid": embedding, "count": 1}
            self.next_id += 1
            return new_id

# ============================================================================
# Main Pipeline
# ============================================================================

def find_model_path():
    asro_path = os.path.expanduser(
        "~/Library/Application Support/net.bytenote.asro/models/qwen3-asr-0.6b"
    )
    if os.path.isdir(asro_path):
        return asro_path
    hf_base = os.path.expanduser(
        "~/.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots"
    )
    if os.path.isdir(hf_base):
        versions = sorted(os.listdir(hf_base))
        if versions:
            return os.path.join(hf_base, versions[-1])
    return None


def list_devices():
    print(sd.query_devices())


def save_transcript(segments, output_path, total_duration):
    """Save transcript to file. Format auto-detected by extension."""
    ext = os.path.splitext(output_path)[1].lower()

    if ext == ".json":
        data = {
            "duration": total_duration,
            "segments": [
                {
                    "time": s["time"],
                    "text": s["text"],
                    "speaker": s.get("speaker", 0),
                    "audio_duration": s.get("audio_duration", 0),
                }
                for s in segments
            ],
        }
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    elif ext == ".srt":
        with open(output_path, "w", encoding="utf-8") as f:
            for i, s in enumerate(segments, 1):
                start = s["time"]
                end = start + s.get("audio_duration", 1.0)
                f.write(f"{i}\n")
                f.write(f"{_srt_time(start)} --> {_srt_time(end)}\n")
                spk = f"[Speaker {s['speaker']}] " if s.get("speaker", 0) > 0 else ""
                f.write(f"{spk}{s['text']}\n\n")

    else:  # .txt or any other
        with open(output_path, "w", encoding="utf-8") as f:
            for s in segments:
                ts = time.strftime("%M:%S", time.gmtime(s["time"]))
                spk = f"[Speaker {s['speaker']}] " if s.get("speaker", 0) > 0 else ""
                f.write(f"[{ts}] {spk}{s['text']}\n")


def _srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def run(vad_only=False, spk=False, device=None, output=None):
    """Main real-time transcription loop."""

    # 1. Initialize VAD
    print(f"{C.DIM}Loading Silero VAD...{C.RESET}")
    vad = VadEngine()
    print(f"{C.GREEN}Silero VAD ready{C.RESET}")

    # 2. Initialize ASR (unless vad-only mode)
    asr = None
    if not vad_only:
        model_path = find_model_path()
        if not model_path:
            print(f"{C.RED}Qwen3-ASR model not found!{C.RESET}")
            sys.exit(1)
        asr = AsrEngine(model_path)

    # 3. Initialize Speaker Tracker (optional)
    speaker = SpeakerTracker()
    if spk:
        speaker.try_init()

    # 4. Audio callback → queue
    audio_queue = queue.Queue()

    def audio_callback(indata, frames, time_info, status):
        if status:
            print(f"{C.DIM}Audio warning: {status}{C.RESET}", file=sys.stderr)
        audio_queue.put(indata[:, 0].copy())  # Mono channel

    # 5. ASR worker thread (non-blocking transcription)
    asr_queue = queue.Queue()  # (pcm_segment, segment_start_time)
    asr_running = threading.Event()
    asr_running.set()

    segment_counter = [0]
    session_start = [0.0]
    transcript_segments = []  # Accumulated results for saving

    def asr_worker():
        while asr_running.is_set():
            try:
                pcm_segment, seg_time = asr_queue.get(timeout=0.5)
            except queue.Empty:
                continue

            seg_duration = len(pcm_segment) / SAMPLE_RATE
            segment_counter[0] += 1
            seg_id = segment_counter[0]

            if vad_only:
                # Just report VAD detection
                print(
                    f"\r{C.GREEN}[{seg_time:.1f}s]{C.RESET} "
                    f"Speech segment #{seg_id} ({seg_duration:.1f}s)"
                    f"                              "
                )
                continue

            # Speaker identification
            spk_id = speaker.identify(pcm_segment) if spk else 0

            # Transcribe
            start = time.time()
            text = asr.transcribe(pcm_segment)
            asr_dur = round(time.time() - start, 2)

            if text:
                transcript_segments.append({
                    "time": seg_time,
                    "text": text,
                    "speaker": spk_id,
                    "audio_duration": round(seg_duration, 1),
                })
                spk_label = ""
                if spk_id > 0:
                    clr = color_speaker(spk_id)
                    spk_label = f"{clr}[Speaker {spk_id}]{C.RESET} "
                # Clear the "listening" line and print result
                print(
                    f"\r{C.BOLD}[{seg_time:.1f}s]{C.RESET} "
                    f"{spk_label}{text}"
                    f"{C.DIM} ({seg_duration:.1f}s audio, {asr_dur}s ASR){C.RESET}"
                    f"                              "
                )
            else:
                print(
                    f"\r{C.DIM}[{seg_time:.1f}s] (empty transcription, "
                    f"{seg_duration:.1f}s audio){C.RESET}"
                    f"                              "
                )

    worker = threading.Thread(target=asr_worker, daemon=True)
    worker.start()

    # 6. Start audio stream
    print(f"\n{C.BOLD}{'='*50}{C.RESET}")
    print(f"{C.BOLD}Real-time Meeting Transcription Demo{C.RESET}")
    print(f"{'='*50}")
    print(f"  VAD: Silero (threshold={VAD_THRESHOLD}, silence={MIN_SILENCE_MS}ms)")
    if not vad_only:
        print(f"  ASR: Qwen3-ASR 0.6B (local)")
    if spk and speaker.available:
        print(f"  SPK: ECAPA-TDNN (threshold={SPEAKER_THRESHOLD})")
    print(f"  Mic: {device or 'default'}")
    print(f"{'='*50}")
    print(f"{C.YELLOW}Press Ctrl+C to stop{C.RESET}\n")

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            blocksize=BLOCK_SIZE,
            channels=CHANNELS,
            dtype=DTYPE,
            callback=audio_callback,
            device=device,
        ):
            session_start[0] = time.time()
            was_speaking = False

            while True:
                try:
                    pcm_chunk = audio_queue.get(timeout=0.1)
                except queue.Empty:
                    continue

                # Feed to VAD
                completed_segments = vad.process_chunk(pcm_chunk)

                # Update status indicator
                if vad.is_speaking and not was_speaking:
                    print(f"\r{C.RED}● 正在聆听...{C.RESET}", end="", flush=True)
                    was_speaking = True
                elif not vad.is_speaking and was_speaking:
                    was_speaking = False

                # Queue completed segments for ASR
                for segment in completed_segments:
                    seg_time = round(time.time() - session_start[0], 1)
                    print(
                        f"\r{C.DIM}● Transcribing...{C.RESET}",
                        end="", flush=True,
                    )
                    asr_queue.put((segment, seg_time))

    except KeyboardInterrupt:
        print(f"\n\n{C.YELLOW}Stopping...{C.RESET}")
        asr_running.clear()
        worker.join(timeout=5)  # Wait for pending ASR to finish

        total = round(time.time() - session_start[0], 1)

        # Auto-save if there are results
        if transcript_segments and not vad_only:
            if not output:
                ts = time.strftime("%Y%m%d_%H%M%S")
                output = os.path.expanduser(f"~/Documents/meeting_{ts}.json")
            os.makedirs(os.path.dirname(output), exist_ok=True)
            save_transcript(transcript_segments, output, total)
            print(f"\n{C.GREEN}Saved to: {output}{C.RESET}")

        print(f"\n{C.BOLD}Session Summary{C.RESET}")
        print(f"  Duration: {total}s")
        print(f"  Segments: {len(transcript_segments) or segment_counter[0]}")
        if spk and speaker.available:
            print(f"  Speakers: {len(speaker.speakers)}")
        print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Real-time meeting transcription CLI")
    parser.add_argument("--vad-only", action="store_true", help="Only run VAD (no ASR)")
    parser.add_argument("--spk", action="store_true", help="Enable speaker diarization")
    parser.add_argument("--list", action="store_true", help="List audio devices")
    parser.add_argument("--device", type=int, default=None, help="Audio device index")
    parser.add_argument("-o", "--output", type=str, default=None,
                        help="Output file path (.json/.txt/.srt, default: ~/Documents/meeting_TIMESTAMP.json)")
    args = parser.parse_args()

    if args.list:
        list_devices()
    else:
        run(vad_only=args.vad_only, spk=args.spk, device=args.device, output=args.output)
