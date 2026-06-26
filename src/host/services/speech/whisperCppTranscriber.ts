// ============================================================================
// whisper-cpp local speech transcription helper
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const LOCAL_SPEECH_CONFIG = {
  WHISPER_PATHS: ['/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'],
  MODEL_DIR: path.join(os.homedir(), '.cache', 'whisper'),
  DEFAULT_MODEL: 'ggml-large-v3-turbo.bin',
  DEFAULT_LANGUAGE: 'zh',
  DEFAULT_THREADS: 4,
  TIMEOUT_MS: 300000,
  SUPPORTED_FORMATS: ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm', '.aac', '.wma'],
  WAV_SAMPLE_RATE: 16000,
} as const;

export type LocalSpeechErrorCode =
  | 'ABORTED'
  | 'EMPTY_RESULT'
  | 'FS_ERROR'
  | 'INVALID_ARGS'
  | 'NOT_INITIALIZED'
  | 'TIMEOUT'
  | 'UNKNOWN';

export class LocalSpeechTranscriptionError extends Error {
  readonly code: LocalSpeechErrorCode;

  constructor(code: LocalSpeechErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LocalSpeechTranscriptionError';
    this.code = code;
  }
}

export interface LocalSpeechTranscribeOptions {
  filePath: string;
  workingDir?: string;
  language?: string;
  model?: string;
  threads?: number;
  outputFormat?: 'text' | 'srt' | 'vtt';
  translate?: boolean;
  signal: AbortSignal;
  logger?: {
    debug?: (message: string, meta?: unknown) => void;
  };
  onStart?: (info: { sourcePath: string; model: string; language: string }) => void;
  onConvert?: (info: { sourcePath: string; outputPath: string; extension: string }) => void;
}

export interface LocalSpeechTranscribeResult {
  text: string;
  sourcePath: string;
  model: string;
  modelPath: string;
  language: string;
  outputFormat: 'text' | 'srt' | 'vtt';
  translate: boolean;
  processingTimeMs: number;
}

export async function findWhisperBinary(signal: AbortSignal): Promise<string | null> {
  for (const p of LOCAL_SPEECH_CONFIG.WHISPER_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { stdout } = await execFileAsync('which', ['whisper-cpp'], { signal });
    const trimmed = stdout.trim();
    if (trimmed && fs.existsSync(trimmed)) return trimmed;
  } catch {
    // not found
  }
  return null;
}

export function normalizeWhisperModelFileName(modelName?: string): string {
  if (!modelName) return LOCAL_SPEECH_CONFIG.DEFAULT_MODEL;
  const trimmed = modelName.trim();
  if (!trimmed) return LOCAL_SPEECH_CONFIG.DEFAULT_MODEL;
  if (trimmed.endsWith('.bin')) return trimmed;
  if (trimmed.startsWith('ggml-')) return `${trimmed}.bin`;
  return `ggml-${trimmed}.bin`;
}

export function getWhisperModelPath(modelName?: string): string {
  return path.join(LOCAL_SPEECH_CONFIG.MODEL_DIR, normalizeWhisperModelFileName(modelName));
}

export async function convertToWav(
  inputPath: string,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      ['-i', inputPath, '-ar', String(LOCAL_SPEECH_CONFIG.WAV_SAMPLE_RATE), '-ac', '1', '-f', 'wav', '-y', outputPath],
      { timeout: 60000, signal },
    );
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await execFileAsync('which', ['ffmpeg'], { signal });
    } catch {
      throw new LocalSpeechTranscriptionError('NOT_INITIALIZED', 'ffmpeg 未安装。请运行: brew install ffmpeg', { cause: error });
    }
    throw new LocalSpeechTranscriptionError('UNKNOWN', `音频转换失败: ${message}`, { cause: error });
  }
}

export function parseWhisperOutput(stdout: string, format: string): string {
  if (format === 'srt' || format === 'vtt') {
    return stdout.trim();
  }
  const lines = stdout.split('\n');
  const textLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/);
    if (match && match[1]) {
      textLines.push(match[1].trim());
    } else if (trimmed && !trimmed.startsWith('[')) {
      textLines.push(trimmed);
    }
  }
  return textLines.join('\n').trim();
}

export async function transcribeWithWhisperCpp(
  options: LocalSpeechTranscribeOptions,
): Promise<LocalSpeechTranscribeResult> {
  const startTime = Date.now();
  const { signal } = options;

  if (signal.aborted) {
    throw new LocalSpeechTranscriptionError('ABORTED', 'aborted');
  }

  const whisperBin = await findWhisperBinary(signal);
  if (!whisperBin) {
    throw new LocalSpeechTranscriptionError('NOT_INITIALIZED', 'whisper-cpp 未安装。请运行: brew install whisper-cpp');
  }

  let filePath = options.filePath;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(options.workingDir || process.cwd(), filePath);
  }

  if (!fs.existsSync(filePath)) {
    throw new LocalSpeechTranscriptionError('FS_ERROR', `文件不存在: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!LOCAL_SPEECH_CONFIG.SUPPORTED_FORMATS.includes(ext as typeof LOCAL_SPEECH_CONFIG.SUPPORTED_FORMATS[number])) {
    throw new LocalSpeechTranscriptionError(
      'INVALID_ARGS',
      `不支持的音频格式: ${ext}。支持: ${LOCAL_SPEECH_CONFIG.SUPPORTED_FORMATS.join(', ')}`,
    );
  }

  const modelFileName = normalizeWhisperModelFileName(options.model);
  const modelPath = getWhisperModelPath(modelFileName);

  if (!fs.existsSync(modelPath)) {
    throw new LocalSpeechTranscriptionError(
      'NOT_INITIALIZED',
      `模型文件不存在: ${modelPath}\n\n请下载模型:\ncurl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(modelPath)}`,
    );
  }

  const language = options.language || LOCAL_SPEECH_CONFIG.DEFAULT_LANGUAGE;
  const threads = options.threads || LOCAL_SPEECH_CONFIG.DEFAULT_THREADS;
  const outputFormat = options.outputFormat || 'text';
  options.onStart?.({ sourcePath: filePath, model: path.basename(modelPath), language });

  let wavPath = filePath;
  let tempWav = false;

  if (ext !== '.wav') {
    wavPath = path.join(path.dirname(filePath), `_whisper_temp_${Date.now()}.wav`);
    tempWav = true;
    options.onConvert?.({ sourcePath: filePath, outputPath: wavPath, extension: ext });
    await convertToWav(filePath, wavPath, signal);
  }

  try {
    const whisperArgs: string[] = [
      '-m', modelPath,
      '-f', wavPath,
      '-l', language,
      '-t', String(threads),
      '--no-prints',
    ];
    if (outputFormat === 'srt') {
      whisperArgs.push('--output-srt');
    } else if (outputFormat === 'vtt') {
      whisperArgs.push('--output-vtt');
    }
    if (options.translate) {
      whisperArgs.push('--translate');
    }

    options.logger?.debug?.('local speech whisper-cpp start', {
      file: path.basename(filePath),
      model: path.basename(modelPath),
      language,
      threads,
    });

    const { stdout, stderr } = await execFileAsync(whisperBin, whisperArgs, {
      timeout: LOCAL_SPEECH_CONFIG.TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      signal,
    });

    if (stderr) {
      options.logger?.debug?.('local speech whisper-cpp stderr', { stderr: stderr.substring(0, 500) });
    }

    const text = parseWhisperOutput(stdout, outputFormat);
    if (!text) {
      throw new LocalSpeechTranscriptionError('EMPTY_RESULT', '转写结果为空，可能音频中没有可识别的语音内容。');
    }

    return {
      text,
      sourcePath: filePath,
      model: path.basename(modelPath),
      modelPath,
      language,
      outputFormat,
      translate: options.translate === true,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error: unknown) {
    if (signal.aborted) {
      throw new LocalSpeechTranscriptionError('ABORTED', 'aborted', { cause: error });
    }
    if (error instanceof LocalSpeechTranscriptionError) {
      throw error;
    }
    const errMeta = error as Record<string, unknown>;
    if (errMeta.killed || errMeta.signal === 'SIGTERM') {
      throw new LocalSpeechTranscriptionError(
        'TIMEOUT',
        `转写超时（超过 ${LOCAL_SPEECH_CONFIG.TIMEOUT_MS / 1000} 秒）。可尝试：\n- 使用更小的模型（如 base 或 small）\n- 增加线程数\n- 分割长音频`,
        { cause: error },
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new LocalSpeechTranscriptionError('UNKNOWN', errMsg, { cause: error });
  } finally {
    if (tempWav && fs.existsSync(wavPath)) {
      try {
        fs.unlinkSync(wavPath);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
