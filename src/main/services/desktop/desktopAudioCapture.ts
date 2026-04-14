// ============================================================================
// DesktopAudioCapture - 后台音频采集 + VAD + ASR
// 使用 sox rec 采集麦克风 → avr-vad (Silero v5) 检测语音 → whisper-cpp/Qwen3-ASR 转录
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { createLogger } from '../infra/logger';
import { getNativeDesktopService } from './nativeDesktopService';
import { getUserConfigDir } from '../../config/configPaths';

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

// Capture mode: microphone (default) or system-audio (ScreenCaptureKit, captures headphone output)
type CaptureMode = 'microphone' | 'system-audio';

// ffmpeg paths — 使用 AVFoundation 采集（sox CoreAudio 在 Tauri 子进程中无法获取 TCC 权限）
const FFMPEG_PATHS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
// sox/rec paths — 仅用于 soxAvailable 检测（实际采集改用 ffmpeg）
const REC_PATHS = ['/opt/homebrew/bin/rec', '/usr/local/bin/rec', '/usr/bin/rec'];
// system-audio-capture Swift tool (ScreenCaptureKit)
const SYSTEM_AUDIO_CAPTURE_NAME = 'system-audio-capture';

// Whisper-cpp paths
const WHISPER_PATHS = ['/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'];
const WHISPER_MODEL_DIR = path.join(os.homedir(), '.cache', 'whisper');
const WHISPER_DEFAULT_MODEL = 'ggml-large-v3-turbo.bin';

// Qwen3-ASR paths
const QWEN_ASR_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/net.bytenote.asro/models/qwen3-asr-0.6b'),
  path.join(os.homedir(), '.cache/huggingface/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots'),
];
// Python3 候选路径 — Tauri 子进程不继承 shell PATH，需要显式查找
const PYTHON3_PATHS = [
  '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3',
  '/Library/Frameworks/Python.framework/Versions/3.13/bin/python3',
  '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
];

// ============================================================================
// State
// ============================================================================

let recProcess: ChildProcess | null = null;
let vadInstance: VadProcessor | null = null;
let capturing = false;
let captureMode: CaptureMode = 'microphone';
let powerMode: 'full' | 'reduced' | 'paused' = 'full';
let powerCheckTimer: ReturnType<typeof setInterval> | null = null;
let totalSegments = 0;
const asrQueue: Array<{ wavPath: string; startMs: number; endMs: number }> = [];
let recBinaryPath: string | null = null; // 缓存 rec 二进制路径
let ffmpegBinaryPath: string | null = null; // 缓存 ffmpeg 二进制路径
let systemAudioBinaryPath: string | null = null; // 缓存 system-audio-capture 路径
let asrProcessing = 0; // number of concurrent ASR workers
const ASR_MAX_CONCURRENCY = 3; // run up to 3 ASR processes in parallel

/** 查找 ffmpeg 二进制 */
function findFfmpegBinary(): string | null {
  if (ffmpegBinaryPath) return ffmpegBinaryPath;
  for (const p of FFMPEG_PATHS) {
    if (fs.existsSync(p)) { ffmpegBinaryPath = p; return p; }
  }
  try {
    ffmpegBinaryPath = execFileSync('which', ['ffmpeg'], { encoding: 'utf-8' }).trim();
    return ffmpegBinaryPath;
  } catch {
    return null;
  }
}

/** 查找或编译 system-audio-capture（ScreenCaptureKit 系统音频采集工具） */
function findSystemAudioCaptureBinary(): string | null {
  if (systemAudioBinaryPath) return systemAudioBinaryPath;

  // 查找预编译二进制（开发目录 → Tauri Resources → 用户 bin）
  const scriptDir = path.join(__dirname, '..', '..', '..', 'scripts');
  const candidates = [
    path.join(scriptDir, SYSTEM_AUDIO_CAPTURE_NAME),
    // Tauri 打包后: __dirname = Resources/_up_/dist/web/, binary = Resources/_up_/scripts/
    path.join(__dirname, '..', '..', 'scripts', SYSTEM_AUDIO_CAPTURE_NAME),
    path.join(getUserConfigDir(), 'bin', SYSTEM_AUDIO_CAPTURE_NAME),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      systemAudioBinaryPath = p;
      return p;
    }
  }

  // 尝试自动编译
  const swiftSource = path.join(scriptDir, `${SYSTEM_AUDIO_CAPTURE_NAME}.swift`);
  if (fs.existsSync(swiftSource)) {
    const outputPath = path.join(scriptDir, SYSTEM_AUDIO_CAPTURE_NAME);
    try {
      logger.error('[音频采集] 编译 system-audio-capture...');
      execFileSync('swiftc', [
        '-O', '-framework', 'ScreenCaptureKit', '-framework', 'AVFoundation',
        '-framework', 'CoreMedia', '-o', outputPath, swiftSource,
      ], { encoding: 'utf-8', timeout: 120_000 });
      systemAudioBinaryPath = outputPath;
      logger.error('[音频采集] system-audio-capture 编译成功');
      return outputPath;
    } catch (error) {
      logger.error('[音频采集] system-audio-capture 编译失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

/** 查找 rec 二进制 — 仅用于兼容性检查 */
function findRecBinary(): string | null {
  if (recBinaryPath) return recBinaryPath;
  for (const p of REC_PATHS) {
    if (fs.existsSync(p)) { recBinaryPath = p; return p; }
  }
  try {
    recBinaryPath = execFileSync('which', ['rec'], { encoding: 'utf-8' }).trim();
    return recBinaryPath;
  } catch {
    return null;
  }
}

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
      // Tauri 打包后 node_modules 在 Resources/_up_/node_modules/
      // require() 默认解析不到，需手动指定路径
      const tauriNodeModules = path.join(__dirname, '..', '..', 'node_modules');
      const cwdNodeModules = path.join(process.cwd(), 'node_modules');
      try {
        this.ort = require('onnxruntime-node');
      } catch {
        // 回退到 Tauri Resources 路径
        for (const nm of [tauriNodeModules, cwdNodeModules]) {
          const ortPath = path.join(nm, 'onnxruntime-node');
          if (fs.existsSync(ortPath)) {
            this.ort = require(ortPath);
            break;
          }
        }
        if (!this.ort) throw new Error('onnxruntime-node not found');
      }

      // 查找 silero_vad_v5.onnx 模型
      let modelPath = '';
      try {
        modelPath = path.join(path.dirname(require.resolve('avr-vad')), 'silero_vad_v5.onnx');
      } catch {
        // require.resolve 失败，手动搜索
        for (const nm of [tauriNodeModules, cwdNodeModules]) {
          const candidate = path.join(nm, 'avr-vad', 'dist', 'silero_vad_v5.onnx');
          if (fs.existsSync(candidate)) {
            modelPath = candidate;
            break;
          }
        }
      }
      if (!modelPath || !fs.existsSync(modelPath)) {
        logger.warn('[音频采集] Silero VAD v5 模型文件不存在', { modelPath, tauriNodeModules });
        return false;
      }
      this.session = await this.ort.InferenceSession.create(modelPath);
      // Initialize hidden state: [2, 1, 128] zeros
      this.state = new this.ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
      this.initialized = true;
      logger.error('[音频采集] VAD (Silero v5 ONNX) 初始化成功');
      return true;
    } catch (error) {
      logger.error('[音频采集] VAD 初始化失败', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    }
  }

  private probLogCount = 0;

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

    // 每 500 次（约 16 秒）输出一次 VAD 概率
    this.probLogCount++;
    if (this.probLogCount % 500 === 0) {
      let maxAmp = 0;
      for (let i = 0; i < pcmInt16.length; i++) {
        const abs = Math.abs(pcmInt16[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      logger.error('[VAD] 概率采样', {
        prob: prob.toFixed(4),
        maxAmp,
        speaking: this.stateMachine.isSpeaking,
        chunks: this.probLogCount,
      });
    }

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
    : path.join(getUserConfigDir(), 'native-desktop');
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

/** 查找安装了 qwen_asr 的 python3 路径（Tauri 子进程不继承 shell PATH） */
let python3BinaryPath: string | null = null;
function findPython3WithQwenAsr(): string | null {
  if (python3BinaryPath) return python3BinaryPath;
  for (const p of PYTHON3_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      execFileSync(p, ['-c', 'import qwen_asr'], { encoding: 'utf-8', timeout: 10_000 });
      python3BinaryPath = p;
      logger.error('[音频ASR] 找到 python3', { path: p });
      return p;
    } catch { /* try next */ }
  }
  return null;
}

async function transcribeWithQwenAsr(wavPath: string): Promise<string | null> {
  const modelPath = findQwenAsrModel();
  if (!modelPath) return null;

  const python3 = findPython3WithQwenAsr();
  if (!python3) {
    logger.warn('[音频ASR] 未找到安装了 qwen_asr 的 python3');
    return null;
  }

  const script = `
import sys, json
from qwen_asr import Qwen3ASRModel
import torch
model = Qwen3ASRModel.from_pretrained("${modelPath.replace(/"/g, '\\"')}", dtype=torch.float32, device_map="cpu")
result = model.transcribe("${wavPath.replace(/"/g, '\\"')}")
text = result[0].text if isinstance(result, list) and len(result) > 0 else str(result)
print(json.dumps({"text": text}))
`;

  // 使用异步 spawn 避免阻塞事件循环（execFileSync 会阻塞 30-60s）
  return new Promise<string | null>((resolve) => {
    const proc = spawn(python3, ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      logger.warn('[音频ASR] Qwen3-ASR 超时');
      resolve(null);
    }, ASR_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn('[音频ASR] Qwen3-ASR 失败', { code, stderr: stderr.slice(0, 200) });
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed.text || null);
      } catch {
        logger.warn('[音频ASR] Qwen3-ASR 输出解析失败', { stdout: stdout.slice(0, 200) });
        resolve(null);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      logger.warn('[音频ASR] Qwen3-ASR 进程错误', { error: err.message });
      resolve(null);
    });
  });
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

async function processOneAsrItem(): Promise<void> {
  const item = asrQueue.shift();
  if (!item) return;

  asrProcessing++;
  try {
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
        queueRemaining: asrQueue.length,
        workers: asrProcessing,
      });
    }
  } finally {
    asrProcessing--;
    // Continue draining the queue
    if (asrQueue.length > 0 && asrProcessing < ASR_MAX_CONCURRENCY) {
      processAsrQueue().catch(() => {});
    }
  }
}

async function processAsrQueue(): Promise<void> {
  // Launch workers up to concurrency limit
  while (asrQueue.length > 0 && asrProcessing < ASR_MAX_CONCURRENCY) {
    processOneAsrItem().catch(() => {});
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

/** 自动检测可用的 AVFoundation 音频输入设备索引（跳过虚拟设备和断开的蓝牙） */
function detectAudioDeviceIndex(): string {
  const ffmpegBin = findFfmpegBinary();
  if (!ffmpegBin) return ':0';

  try {
    // ffmpeg -list_devices 输出在 stderr
    const result = execFileSync(ffmpegBin, [
      '-f', 'avfoundation', '-list_devices', 'true', '-i', '',
    ], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return parseAudioDevices(result);
  } catch (error: unknown) {
    // ffmpeg -list_devices always exits with error, but output is in stderr
    const stderr = (error as { stderr?: string })?.stderr || '';
    return parseAudioDevices(stderr);
  }
}

/** 解析 ffmpeg 设备列表，返回最佳音频输入设备索引 */
function parseAudioDevices(output: string): string {
  const lines = output.split('\n');
  let inAudio = false;
  const devices: Array<{ index: number; name: string }> = [];
  // 虚拟设备 — 不用于录音
  const virtualDevices = new Set(['BlackHole', 'LarkAudioDevice', 'Microsoft Teams Audio', 'Soundflower']);

  for (const line of lines) {
    if (line.includes('AVFoundation audio devices:')) { inAudio = true; continue; }
    if (inAudio) {
      const match = line.match(/\[(\d+)\]\s+(.+)/);
      if (match) {
        devices.push({ index: parseInt(match[1], 10), name: match[2].trim() });
      }
    }
  }

  if (devices.length === 0) return ':0';

  // 优先内置麦克风，其次非虚拟设备
  const builtin = devices.find(d => d.name.includes('MacBook') && d.name.includes('Microphone'));
  if (builtin) {
    logger.error('[音频采集] 选择内置麦克风', { index: builtin.index, name: builtin.name });
    return `:${builtin.index}`;
  }

  const real = devices.filter(d => !virtualDevices.has(d.name) && !d.name.includes('BlackHole'));
  if (real.length > 0) {
    logger.error('[音频采集] 选择可用麦克风', { index: real[0].index, name: real[0].name });
    return `:${real[0].index}`;
  }

  return `:${devices[0].index}`;
}

function startRecCapture(mode: CaptureMode = 'microphone'): boolean {
  if (recProcess) return true;

  try {
    // 系统音频模式：使用 ScreenCaptureKit 采集（戴耳机也能录会议音频）
    if (mode === 'system-audio') {
      const sysAudioBin = findSystemAudioCaptureBinary();
      if (sysAudioBin) {
        logger.error('[音频采集] 使用 ScreenCaptureKit 系统音频模式');
        recProcess = spawn(sysAudioBin, [], { stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        logger.error('[音频采集] system-audio-capture 不可用，回退到麦克风模式');
        mode = 'microphone';
      }
    }

    // 麦克风模式：优先使用 ffmpeg + AVFoundation（macOS TCC 兼容），fallback 到 sox rec
    if (mode === 'microphone') {
    const ffmpegBin = findFfmpegBinary();
    if (ffmpegBin) {
      const audioDevice = detectAudioDeviceIndex();
      logger.error('[音频采集] 使用 ffmpeg AVFoundation 模式', { device: audioDevice });
      recProcess = spawn(ffmpegBin, [
        '-f', 'avfoundation', '-i', audioDevice,
        '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      logger.error('[音频采集] ffmpeg 不可用，fallback 到 sox rec');
      const recBin = findRecBinary() || 'rec';
      recProcess = spawn(recBin, [
        '-q', '-t', 'raw', '-r', String(SAMPLE_RATE), '-c', '1', '-b', '16', '-e', 'signed-integer', '-',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    } // end if (mode === 'microphone')

    if (!recProcess) return false;

    let accumBuffer = Buffer.alloc(0);

    let vadErrorLogged = false;
    let dataChunkCount = 0;
    let lastDiagMs = 0;

    recProcess.stdout!.on('data', async (data: Buffer) => {
      if (powerMode === 'paused') return;

      dataChunkCount++;
      if (dataChunkCount === 1) {
        logger.error('[音频采集] 首次收到 rec 数据', { bytes: data.length });
      }

      // 每 10 秒输出一次音频振幅诊断
      const now = Date.now();
      if (now - lastDiagMs > 10_000) {
        lastDiagMs = now;
        const int16View = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + Math.min(data.length, 1024)));
        let maxAmp = 0;
        for (let i = 0; i < int16View.length; i++) {
          const abs = Math.abs(int16View[i]);
          if (abs > maxAmp) maxAmp = abs;
        }
        logger.error('[音频采集] 振幅诊断', {
          chunks: dataChunkCount,
          maxAmp,
          maxAmpPct: `${(maxAmp / 32768 * 100).toFixed(1)}%`,
          vadSpeaking: vadInstance?.isSpeaking ?? false,
        });
      }

      accumBuffer = Buffer.concat([accumBuffer, data]);

      while (accumBuffer.length >= BLOCK_BYTES) {
        const chunk = accumBuffer.subarray(0, BLOCK_BYTES);
        accumBuffer = accumBuffer.subarray(BLOCK_BYTES);

        const int16 = new Int16Array(
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + BLOCK_BYTES)
        );

        if (vadInstance) {
          try {
            const segments = await vadInstance.processChunk(int16);
            for (const segment of segments) {
              const endMs = Date.now();
              const durationMs = Math.round((segment.length / SAMPLE_RATE) * 1000);
              const startMs = endMs - durationMs;

              // Save WAV and queue for ASR
              try {
                const wavPath = saveWavFile(segment, startMs);
                logger.error('[音频采集] 语音段完成', {
                  duration: `${durationMs}ms`,
                  samples: segment.length,
                  file: path.basename(wavPath),
                });
                asrQueue.push({ wavPath, startMs, endMs });
                // Process ASR in background
                processAsrQueue().catch(() => {});
              } catch (error) {
                logger.error('[音频采集] 保存语音段失败', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          } catch (error) {
            if (!vadErrorLogged) {
              vadErrorLogged = true;
              logger.error('[音频采集] VAD processChunk 异常（后续不再重复）', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
            }
          }
        }
      }
    });

    // 捕获 stderr — rec 权限/设备错误会输出到这里
    const stderrChunks: string[] = [];
    recProcess.stderr!.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) stderrChunks.push(msg);
      if (stderrChunks.length <= 3) {
        logger.error('[音频采集] rec stderr', { message: msg });
      }
    });

    recProcess.on('error', (err) => {
      logger.error('[音频采集] rec 进程错误', { error: err.message });
      recProcess = null;
    });

    recProcess.on('exit', (code) => {
      recProcess = null;
      if (capturing) {
        logger.error('[音频采集] rec 进程意外退出，3 秒后自动重启', { code, mode });
        setTimeout(() => {
          if (capturing && !recProcess) {
            logger.error('[音频采集] 正在重启 rec 进程...');
            startRecCapture(captureMode);
          }
        }, 3000);
      }
    });

    logger.error('[音频采集] rec 进程已启动 (16kHz mono PCM)');
    return true;
  } catch (error) {
    logger.error('[音频采集] 启动 rec 进程失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

let fifoStream: fs.ReadStream | null = null;

/** 从 FIFO（Tauri Rust 端启动的 rec 写入）读取音频数据 */
function startFifoCapture(fifoPath: string): boolean {
  try {
    logger.error('[音频采集] 从 FIFO 读取音频', { fifoPath });

    fifoStream = fs.createReadStream(fifoPath, { highWaterMark: BLOCK_BYTES * 4 });

    let accumBuffer = Buffer.alloc(0);
    let vadErrorLogged = false;
    let dataChunkCount = 0;
    let lastDiagMs = 0;

    fifoStream.on('data', async (data: Buffer | string) => {
      if (typeof data === 'string') return; // skip string chunks
      if (powerMode === 'paused') return;

      dataChunkCount++;
      if (dataChunkCount === 1) {
        logger.error('[音频采集] 首次收到 FIFO 数据', { bytes: data.length });
      }

      // 每 10 秒输出一次音频振幅诊断
      const now = Date.now();
      if (now - lastDiagMs > 10_000) {
        lastDiagMs = now;
        const int16View = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + Math.min(data.length, 1024)));
        let maxAmp = 0;
        for (let i = 0; i < int16View.length; i++) {
          const abs = Math.abs(int16View[i]);
          if (abs > maxAmp) maxAmp = abs;
        }
        logger.error('[音频采集] FIFO 振幅诊断', {
          chunks: dataChunkCount,
          maxAmp,
          maxAmpPct: `${(maxAmp / 32768 * 100).toFixed(1)}%`,
          vadSpeaking: vadInstance?.isSpeaking ?? false,
        });
      }

      accumBuffer = Buffer.concat([accumBuffer, data]);

      while (accumBuffer.length >= BLOCK_BYTES) {
        const chunk = accumBuffer.subarray(0, BLOCK_BYTES);
        accumBuffer = accumBuffer.subarray(BLOCK_BYTES);

        const int16 = new Int16Array(
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + BLOCK_BYTES)
        );

        if (vadInstance) {
          try {
            const segments = await vadInstance.processChunk(int16);
            for (const segment of segments) {
              const endMs = Date.now();
              const durationMs = Math.round((segment.length / SAMPLE_RATE) * 1000);
              const startMs = endMs - durationMs;

              try {
                const wavPath = saveWavFile(segment, startMs);
                logger.error('[音频采集] 语音段完成', {
                  duration: `${durationMs}ms`,
                  samples: segment.length,
                  file: path.basename(wavPath),
                });
                asrQueue.push({ wavPath, startMs, endMs });
                processAsrQueue().catch(() => {});
              } catch (error) {
                logger.error('[音频采集] 保存语音段失败', {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          } catch (error) {
            if (!vadErrorLogged) {
              vadErrorLogged = true;
              logger.error('[音频采集] VAD processChunk 异常（后续不再重复）', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
              });
            }
          }
        }
      }
    });

    fifoStream.on('error', (err) => {
      logger.error('[音频采集] FIFO 读取错误', { error: err.message });
      fifoStream = null;
    });

    fifoStream.on('end', () => {
      if (capturing) {
        logger.error('[音频采集] FIFO 流结束');
      }
      fifoStream = null;
    });

    return true;
  } catch (error) {
    logger.error('[音频采集] 打开 FIFO 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function startDesktopAudioCapture(fifoPath?: string, mode: CaptureMode = 'microphone'): Promise<void> {
  if (capturing) return;

  // 系统音频模式不需要 ffmpeg/sox
  if (mode === 'system-audio') {
    if (!findSystemAudioCaptureBinary()) {
      logger.error('[音频采集] system-audio-capture 不可用，回退到麦克风模式');
      mode = 'microphone';
    }
  }

  // Check audio capture tool availability
  if (mode === 'microphone' && !fifoPath && !findFfmpegBinary() && !findRecBinary()) {
    logger.error('[音频采集] ffmpeg/sox 均未安装，跳过音频采集。安装: brew install ffmpeg');
    return;
  }

  captureMode = mode;

  // Initialize VAD
  vadInstance = new VadProcessor();
  const vadReady = await vadInstance.init();
  if (!vadReady) {
    logger.error('[音频采集] VAD 初始化失败，跳过音频采集');
    return;
  }

  // Ensure SQLite table
  const sqlitePath = getSqlitePath();
  if (sqlitePath) {
    ensureAudioTable(sqlitePath);
  }

  // Start capture — prefer FIFO (Rust TCC) over direct spawn
  capturing = true;
  let started = false;
  if (fifoPath && fs.existsSync(fifoPath)) {
    started = startFifoCapture(fifoPath);
    logger.error('[音频采集] 使用 Tauri FIFO 模式', { fifoPath });
  } else {
    started = startRecCapture(mode);
    logger.error('[音频采集] 使用直接 spawn 模式', { mode });
  }

  if (!started) {
    capturing = false;
    return;
  }

  // Power management timer
  powerCheckTimer = setInterval(() => {
    const newMode = checkPowerState();
    if (newMode !== powerMode) {
      logger.error('[音频采集] 电源模式切换', { from: powerMode, to: newMode });
      powerMode = newMode;
    }
  }, POWER_CHECK_INTERVAL_MS);

  logger.error('[音频采集] 后台音频采集已启动');
}

export function stopDesktopAudioCapture(): void {
  capturing = false;
  captureMode = 'microphone';
  if (recProcess) {
    recProcess.kill();
    recProcess = null;
  }
  if (fifoStream) {
    fifoStream.destroy();
    fifoStream = null;
  }
  if (powerCheckTimer) {
    clearInterval(powerCheckTimer);
    powerCheckTimer = null;
  }
  vadInstance = null;
  logger.error('[音频采集] 后台音频采集已停止');
}

export function getAudioCaptureStatus() {
  return {
    capturing,
    captureMode,
    vadReady: vadInstance?.isSpeaking !== undefined,
    soxAvailable: !!findFfmpegBinary() || !!findRecBinary(),
    systemAudioAvailable: !!findSystemAudioCaptureBinary(),
    asrEngine: findWhisperBinary() ? 'whisper-cpp' : findQwenAsrModel() ? 'qwen3-asr' : 'none',
    powerMode,
    totalSegments,
    audioDir: getAudioDir(),
    queueLength: asrQueue.length,
  };
}
