// ============================================================================
// DesktopAudioCapture - 后台音频采集 + VAD + ASR
// 使用 sox rec 采集麦克风 → avr-vad (Silero v5) 检测语音 → whisper-cpp/Qwen3-ASR 转录
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { createLogger } from './infra/logger';
import { getNativeDesktopService } from './nativeDesktopService';

const logger = createLogger('DesktopAudioCapture');

// ============================================================================
// Config
// ============================================================================

const SAMPLE_RATE = 16000;
const BLOCK_SIZE = 512; // 512 samples = 32ms at 16kHz
const BLOCK_BYTES = BLOCK_SIZE * 2; // 16-bit = 2 bytes per sample

// VAD thresholds (Silero v5, matching meeting-cli's hysteresis)
const VAD_ONSET = 0.5; // start speech: high threshold
const VAD_OFFSET = 0.35; // end speech: lower threshold
const MIN_SPEECH_MS = 500; // minimum speech duration to keep
const MIN_SILENCE_MS = 2000; // 2s silence to finalize segment
const SPEECH_PAD_MS = 200; // pad speech boundaries
const MAX_SPEECH_S = 15; // max segment duration, then smart-split

// ASR
const ASR_TIMEOUT_MS = 120_000;

// Power management check interval
const POWER_CHECK_INTERVAL_MS = 60_000;

// Whisper-cpp paths
const WHISPER_PATHS = ['/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'];
const WHISPER_MODEL_DIR = path.join(os.homedir(), '.cache', 'whisper');
const WHISPER_DEFAULT_MODEL = 'ggml-large-v3-turbo.bin';

// Qwen3-ASR paths
const QWEN_ASR_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/net.bytenote.asro/models/qwen3-asr-0.6b'),
  path.join(os.homedir(), '.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots'),
];

// ============================================================================
// State
// ============================================================================

let recProcess: ChildProcess | null = null;
let vadInstance: VadProcessor | null = null;
let capturing = false;
let powerMode: 'full' | 'reduced' | 'paused' = 'full';
let powerCheckTimer: ReturnType<typeof setInterval> | null = null;
let totalSegments = 0;
let asrQueue: Array<{ wavPath: string; startMs: number; endMs: number }> = [];
let asrProcessing = false;

// ============================================================================
// VAD State Machine (ported from meeting-cli VadEngine)
// ============================================================================

class VadStateMachine {
  private speechActive = false;
  private speechBuffer: number[] = [];
  private speechSamples = 0;
  private silenceSamples = 0;
  private probHistory: number[] = [];
  private pendingPad: number[] = [];

  private readonly onset: number;
  private readonly offset: number;
  private readonly minSpeechSamples: number;
  private readonly minSilenceSamples: number;
  private readonly speechPadSamples: number;
  private readonly maxSpeechSamples: number;

  constructor(onset = VAD_ONSET, offset = VAD_OFFSET) {
    this.onset = onset;
    this.offset = offset;
    this.minSpeechSamples = Math.floor(MIN_SPEECH_MS * SAMPLE_RATE / 1000);
    this.minSilenceSamples = Math.floor(MIN_SILENCE_MS * SAMPLE_RATE / 1000);
    this.speechPadSamples = Math.floor(SPEECH_PAD_MS * SAMPLE_RATE / 1000);
    this.maxSpeechSamples = Math.floor(MAX_SPEECH_S * SAMPLE_RATE);
  }

  processChunk(pcmInt16: Int16Array, prob: number): Int16Array[] {
    const completed: Int16Array[] = [];
    const chunkLen = pcmInt16.length;

    // Hysteresis: use onset to START speech, offset to END speech
    const isSpeech = this.speechActive ? prob >= this.offset : prob >= this.onset;

    if (isSpeech) {
      if (!this.speechActive) {
        // Speech onset
        this.speechActive = true;
        this.speechBuffer = [...this.pendingPad];
        this.speechSamples = this.speechBuffer.length;
        this.silenceSamples = 0;
        this.probHistory = [];
      }

      for (let i = 0; i < pcmInt16.length; i++) {
        this.speechBuffer.push(pcmInt16[i]);
      }
      this.speechSamples += chunkLen;
      this.silenceSamples = 0;
      this.probHistory.push(prob);

      // Smart max-duration split
      if (this.speechSamples >= this.maxSpeechSamples) {
        const segment = this.smartSplit();
        if (segment) completed.push(segment);
      }
    } else {
      if (this.speechActive) {
        for (let i = 0; i < pcmInt16.length; i++) {
          this.speechBuffer.push(pcmInt16[i]);
        }
        this.silenceSamples += chunkLen;
        this.probHistory.push(prob);

        if (this.silenceSamples >= this.minSilenceSamples) {
          // Silence long enough → finalize segment
          if (this.speechSamples >= this.minSpeechSamples) {
            completed.push(new Int16Array(this.speechBuffer));
          }
          this.speechActive = false;
          this.speechBuffer = [];
          this.speechSamples = 0;
          this.silenceSamples = 0;
          this.probHistory = [];
        }
        // Short gaps (breathing) → keep buffering
      }
    }

    // Keep tail for padding next onset
    const padStart = Math.max(0, pcmInt16.length - this.speechPadSamples);
    this.pendingPad = Array.from(pcmInt16.slice(padStart));

    return completed;
  }

  private smartSplit(): Int16Array | null {
    if (this.probHistory.length === 0) {
      const seg = new Int16Array(this.speechBuffer);
      this.speechBuffer = [];
      this.speechSamples = 0;
      this.probHistory = [];
      return seg;
    }

    // Find lowest-prob chunk in second half
    const half = Math.floor(this.probHistory.length / 2);
    const secondHalf = this.probHistory.slice(half);
    let minIdx = half;
    let minVal = secondHalf[0];
    for (let i = 1; i < secondHalf.length; i++) {
      if (secondHalf[i] < minVal) {
        minVal = secondHalf[i];
        minIdx = half + i;
      }
    }

    const splitSample = minIdx * BLOCK_SIZE;
    if (splitSample <= 0 || splitSample >= this.speechBuffer.length) {
      const seg = new Int16Array(this.speechBuffer);
      this.speechBuffer = [];
      this.speechSamples = 0;
      this.probHistory = [];
      return seg;
    }

    const firstPart = new Int16Array(this.speechBuffer.slice(0, splitSample));
    this.speechBuffer = this.speechBuffer.slice(splitSample);
    this.speechSamples = this.speechBuffer.length;
    this.probHistory = this.probHistory.slice(minIdx);
    return firstPart;
  }

  get isSpeaking(): boolean {
    return this.speechActive;
  }
}

// ============================================================================
// Silero VAD v5 Processor (direct ONNX Runtime, no wrapper)
// ============================================================================

class VadProcessor {
  private session: any; // ort.InferenceSession
  private ort: any;
  private state: any; // ort.Tensor — hidden state carried across frames
  private stateMachine: VadStateMachine;
  private initialized = false;

  constructor() {
    this.stateMachine = new VadStateMachine();
  }

  async init(): Promise<boolean> {
    try {
      this.ort = require('onnxruntime-node');
      const modelPath = path.join(
        path.dirname(require.resolve('avr-vad')),
        'silero_vad_v5.onnx'
      );
      if (!fs.existsSync(modelPath)) {
        logger.warn('[音频采集] Silero VAD v5 模型文件不存在', { modelPath });
        return false;
      }
      this.session = await this.ort.InferenceSession.create(modelPath);
      // Initialize hidden state: [2, 1, 128] zeros
      this.state = new this.ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
      this.initialized = true;
      logger.info('[音频采集] VAD (Silero v5 ONNX) 初始化成功');
      return true;
    } catch (error) {
      logger.warn('[音频采集] VAD 初始化失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async processChunk(pcmInt16: Int16Array): Promise<Int16Array[]> {
    if (!this.initialized) return [];

    // Convert Int16 to Float32 [-1.0, 1.0]
    const float32 = new Float32Array(pcmInt16.length);
    for (let i = 0; i < pcmInt16.length; i++) {
      float32[i] = pcmInt16[i] / 32768.0;
    }

    // Run Silero v5: input=[1, chunk_size], state=[2,1,128], sr=scalar
    const input = new this.ort.Tensor('float32', float32, [1, float32.length]);
    const sr = new this.ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);

    const result = await this.session.run({ input, state: this.state, sr });
    const prob = result.output.data[0] as number;
    this.state = result.stateN; // carry hidden state forward

    return this.stateMachine.processChunk(pcmInt16, prob);
  }

  get isSpeaking(): boolean {
    return this.stateMachine.isSpeaking;
  }
}

// ============================================================================
// WAV File Operations
// ============================================================================

function getAudioDir(): string {
  const service = getNativeDesktopService();
  const status = service.getStatus();
  const root = status.sqliteDbPath
    ? path.dirname(status.sqliteDbPath)
    : path.join(os.homedir(), '.code-agent', 'native-desktop');
  return path.join(root, 'audio');
}

function getDailyAudioDir(): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dir = path.join(getAudioDir(), today);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveWavFile(pcm: Int16Array, startMs: number): string {
  const dir = getDailyAudioDir();
  const filename = `audio_${startMs}.wav`;
  const wavPath = path.join(dir, filename);

  // Write WAV header + PCM data
  const dataBytes = pcm.length * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const pcmBuffer = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcmBuffer]));
  return wavPath;
}

// ============================================================================
// ASR (Transcription)
// ============================================================================

function findWhisperBinary(): string | null {
  for (const p of WHISPER_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const result = execFileSync('which', ['whisper-cpp'], { encoding: 'utf-8' }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch { /* not found */ }
  return null;
}

function findWhisperModel(): string | null {
  const modelPath = path.join(WHISPER_MODEL_DIR, WHISPER_DEFAULT_MODEL);
  if (fs.existsSync(modelPath)) return modelPath;
  // Check for any ggml model
  if (fs.existsSync(WHISPER_MODEL_DIR)) {
    const files = fs.readdirSync(WHISPER_MODEL_DIR).filter(f => f.startsWith('ggml-') && f.endsWith('.bin'));
    if (files.length > 0) return path.join(WHISPER_MODEL_DIR, files[0]);
  }
  return null;
}

function findQwenAsrModel(): string | null {
  for (const p of QWEN_ASR_PATHS) {
    if (fs.existsSync(p)) {
      // Check for snapshots directory (huggingface cache)
      if (p.includes('snapshots')) {
        const versions = fs.readdirSync(p).filter(f => !f.startsWith('.'));
        if (versions.length > 0) return path.join(p, versions[versions.length - 1]);
      }
      if (fs.existsSync(path.join(p, 'model.safetensors'))) return p;
    }
  }
  return null;
}

async function transcribeWithWhisperCpp(wavPath: string): Promise<string | null> {
  const binary = findWhisperBinary();
  const model = findWhisperModel();
  if (!binary || !model) return null;

  try {
    const result = execFileSync(binary, [
      '-m', model, '-f', wavPath, '-l', 'zh', '-t', '4', '--no-prints',
    ], { encoding: 'utf-8', timeout: ASR_TIMEOUT_MS });

    // Parse output: [timestamp] text
    const lines = result.split('\n');
    const textParts: string[] = [];
    for (const line of lines) {
      const match = line.trim().match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/);
      if (match?.[1]) textParts.push(match[1].trim());
      else if (line.trim() && !line.trim().startsWith('[')) textParts.push(line.trim());
    }
    return textParts.join(' ').trim() || null;
  } catch (error) {
    logger.warn('[音频ASR] whisper-cpp 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function transcribeWithQwenAsr(wavPath: string): Promise<string | null> {
  const modelPath = findQwenAsrModel();
  if (!modelPath) return null;

  try {
    const script = `
import sys, json, tempfile, wave
from qwen_asr import Qwen3ASRModel
import torch
model = Qwen3ASRModel.from_pretrained("${modelPath.replace(/"/g, '\\"')}", dtype=torch.float32, device_map="cpu")
result = model.transcribe("${wavPath.replace(/"/g, '\\"')}")
print(json.dumps({"text": result}))
`;
    const result = execFileSync('python3', ['-c', script], {
      encoding: 'utf-8',
      timeout: ASR_TIMEOUT_MS,
    });
    const parsed = JSON.parse(result.trim());
    return parsed.text || null;
  } catch (error) {
    logger.warn('[音频ASR] Qwen3-ASR 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function transcribeSegment(wavPath: string): Promise<{ text: string | null; engine: string }> {
  // Fallback chain: whisper-cpp → Qwen3-ASR
  const whisperResult = await transcribeWithWhisperCpp(wavPath);
  if (whisperResult) return { text: whisperResult, engine: 'whisper-cpp' };

  const qwenResult = await transcribeWithQwenAsr(wavPath);
  if (qwenResult) return { text: qwenResult, engine: 'qwen3-asr' };

  return { text: null, engine: 'none' };
}

// ============================================================================
// SQLite Persistence
// ============================================================================

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function getSqlitePath(): string | null {
  const service = getNativeDesktopService();
  const status = service.getStatus();
  return status.sqliteDbPath && fs.existsSync(status.sqliteDbPath) ? status.sqliteDbPath : null;
}

function ensureAudioTable(sqlitePath: string): void {
  const sql = `
CREATE TABLE IF NOT EXISTS audio_segments (
  id TEXT PRIMARY KEY,
  start_at_ms INTEGER NOT NULL,
  end_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  wav_path TEXT,
  transcript TEXT,
  speaker_id INTEGER DEFAULT 0,
  asr_engine TEXT,
  asr_duration_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audio_start ON audio_segments (start_at_ms DESC);
`;
  try {
    execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' });
  } catch (error) {
    logger.warn('[音频采集] 创建 audio_segments 表失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function persistAudioSegment(
  sqlitePath: string,
  segment: {
    id: string;
    startAtMs: number;
    endAtMs: number;
    durationMs: number;
    wavPath: string;
    transcript: string | null;
    asrEngine: string;
    asrDurationMs: number;
  }
): void {
  const transcript = segment.transcript ? `'${sqlEscape(segment.transcript)}'` : 'NULL';
  const sql = `INSERT OR REPLACE INTO audio_segments (id, start_at_ms, end_at_ms, duration_ms, wav_path, transcript, asr_engine, asr_duration_ms, created_at_ms) VALUES ('${sqlEscape(segment.id)}', ${segment.startAtMs}, ${segment.endAtMs}, ${segment.durationMs}, '${sqlEscape(segment.wavPath)}', ${transcript}, '${sqlEscape(segment.asrEngine)}', ${segment.asrDurationMs}, ${Date.now()});`;
  try {
    execFileSync('sqlite3', [sqlitePath, sql], { encoding: 'utf-8' });
  } catch (error) {
    logger.warn('[音频采集] 写入 audio_segments 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ============================================================================
// ASR Queue Processor
// ============================================================================

async function processAsrQueue(): Promise<void> {
  if (asrProcessing || asrQueue.length === 0) return;
  asrProcessing = true;

  try {
    while (asrQueue.length > 0) {
      const item = asrQueue.shift()!;
      const asrStart = Date.now();
      const { text, engine } = await transcribeSegment(item.wavPath);
      const asrDuration = Date.now() - asrStart;

      const sqlitePath = getSqlitePath();
      if (sqlitePath) {
        persistAudioSegment(sqlitePath, {
          id: `audio-${item.startMs}`,
          startAtMs: item.startMs,
          endAtMs: item.endMs,
          durationMs: item.endMs - item.startMs,
          wavPath: item.wavPath,
          transcript: text,
          asrEngine: engine,
          asrDurationMs: asrDuration,
        });
      }

      if (text) {
        totalSegments++;
        logger.info('[音频ASR] 转录完成', {
          engine,
          duration: `${item.endMs - item.startMs}ms`,
          textLength: text.length,
          asrTime: `${asrDuration}ms`,
        });
      }
    }
  } finally {
    asrProcessing = false;
  }
}

// ============================================================================
// Power Management
// ============================================================================

function checkPowerState(): 'full' | 'reduced' | 'paused' {
  try {
    const service = getNativeDesktopService();
    const status = service.getStatus();
    const sqlitePath = status.sqliteDbPath;
    if (!sqlitePath || !fs.existsSync(sqlitePath)) return 'full';

    const output = execFileSync('sqlite3', ['-json', sqlitePath,
      "SELECT raw_json FROM desktop_activity_events ORDER BY captured_at_ms DESC LIMIT 1;",
    ], { encoding: 'utf-8' }).trim();
    if (!output) return 'full';

    const rows = JSON.parse(output);
    if (rows.length === 0) return 'full';
    const event = JSON.parse(rows[0].raw_json);

    if (event.onAcPower) return 'full';
    const battery = event.batteryPercent;
    if (battery != null && battery < 20) return 'paused';
    if (battery != null && battery < 50) return 'reduced';
    return 'full';
  } catch {
    return 'full';
  }
}

// ============================================================================
// Core Audio Capture
// ============================================================================

function startRecCapture(): boolean {
  if (recProcess) return true;

  try {
    // Spawn sox rec: output raw 16kHz mono PCM to stdout
    recProcess = spawn('rec', [
      '-q', '-t', 'raw', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    let accumBuffer = Buffer.alloc(0);

    recProcess.stdout!.on('data', async (data: Buffer) => {
      if (powerMode === 'paused') return;

      accumBuffer = Buffer.concat([accumBuffer, data]);

      while (accumBuffer.length >= BLOCK_BYTES) {
        const chunk = accumBuffer.subarray(0, BLOCK_BYTES);
        accumBuffer = accumBuffer.subarray(BLOCK_BYTES);

        const int16 = new Int16Array(
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + BLOCK_BYTES)
        );

        if (vadInstance) {
          const segments = await vadInstance.processChunk(int16);
          for (const segment of segments) {
            const endMs = Date.now();
            const durationMs = Math.round((segment.length / SAMPLE_RATE) * 1000);
            const startMs = endMs - durationMs;

            // Save WAV and queue for ASR
            try {
              const wavPath = saveWavFile(segment, startMs);
              logger.info('[音频采集] 语音段完成', {
                duration: `${durationMs}ms`,
                samples: segment.length,
                file: path.basename(wavPath),
              });
              asrQueue.push({ wavPath, startMs, endMs });
              // Process ASR in background
              processAsrQueue().catch(() => {});
            } catch (error) {
              logger.warn('[音频采集] 保存语音段失败', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      }
    });

    recProcess.on('error', (err) => {
      logger.warn('[音频采集] rec 进程错误', { error: err.message });
      recProcess = null;
    });

    recProcess.on('exit', (code) => {
      if (capturing) {
        logger.warn('[音频采集] rec 进程退出，将在下次检查时重启', { code });
      }
      recProcess = null;
    });

    logger.info('[音频采集] rec 进程已启动 (16kHz mono PCM)');
    return true;
  } catch (error) {
    logger.warn('[音频采集] 启动 rec 进程失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function startDesktopAudioCapture(): Promise<void> {
  if (capturing) return;

  // Check sox availability
  try {
    execFileSync('which', ['rec'], { encoding: 'utf-8' });
  } catch {
    logger.warn('[音频采集] sox/rec 未安装，跳过音频采集。安装: brew install sox');
    return;
  }

  // Initialize VAD
  vadInstance = new VadProcessor();
  const vadReady = await vadInstance.init();
  if (!vadReady) {
    logger.warn('[音频采集] VAD 初始化失败，跳过音频采集');
    return;
  }

  // Ensure SQLite table
  const sqlitePath = getSqlitePath();
  if (sqlitePath) {
    ensureAudioTable(sqlitePath);
  }

  // Start capture
  capturing = true;
  const started = startRecCapture();
  if (!started) {
    capturing = false;
    return;
  }

  // Power management timer
  powerCheckTimer = setInterval(() => {
    const newMode = checkPowerState();
    if (newMode !== powerMode) {
      logger.info('[音频采集] 电源模式切换', { from: powerMode, to: newMode });
      powerMode = newMode;

      if (powerMode === 'paused' && recProcess) {
        recProcess.kill();
        recProcess = null;
      } else if (powerMode !== 'paused' && !recProcess) {
        startRecCapture();
      }
    }
  }, POWER_CHECK_INTERVAL_MS);

  logger.info('[音频采集] 后台音频采集已启动');
}

export function stopDesktopAudioCapture(): void {
  capturing = false;
  if (recProcess) {
    recProcess.kill();
    recProcess = null;
  }
  if (powerCheckTimer) {
    clearInterval(powerCheckTimer);
    powerCheckTimer = null;
  }
  vadInstance = null;
  logger.info('[音频采集] 后台音频采集已停止');
}

export function getAudioCaptureStatus() {
  return {
    capturing,
    vadReady: vadInstance?.isSpeaking !== undefined,
    soxAvailable: (() => { try { execFileSync('which', ['rec'], { encoding: 'utf-8' }); return true; } catch { return false; } })(),
    asrEngine: findWhisperBinary() ? 'whisper-cpp' : findQwenAsrModel() ? 'qwen3-asr' : 'none',
    powerMode,
    totalSegments,
    audioDir: getAudioDir(),
    queueLength: asrQueue.length,
  };
}
