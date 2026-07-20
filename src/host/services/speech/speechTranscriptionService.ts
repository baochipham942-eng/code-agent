// ============================================================================
// SpeechTranscriptionService - desktop voice input ASR boundary
// ============================================================================

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Groq from 'groq-sdk';
import {
  DEFAULT_SPEECH_INPUT_SETTINGS,
  type SpeechInputSettings,
  type SpeechTranscribeOptions,
  type SpeechTranscribeResult,
  type SpeechRetainedAudioClearResult,
  type SpeechTranscriptionSegment,
  type SpeechTranscriptionEngine,
  type SpeechTranscriptionMode,
} from '../../../shared/contract/speech';
import { getConfigService } from '../core/configService';
import { createLogger } from '../infra/logger';
import {
  LocalSpeechTranscriptionError,
  normalizeWhisperModelFileName,
  transcribeWithWhisperCpp,
} from './whisperCppTranscriber';

const logger = createLogger('SpeechTranscriptionService');
const execFileAsync = promisify(execFile);

const MAX_SINGLE_PASS_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_COMPOSER_AUDIO_BYTES = 50 * 1024 * 1024;
const MIN_COMPOSER_AUDIO_BYTES = 500;
const CHUNK_AUDIO_AFTER_SECONDS = 60;
const RETAINED_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

const HALLUCINATION_PATTERNS = [
  '请不吝点赞',
  '订阅转发',
  '打赏支持',
  '明镜与点点',
  '点赞订阅',
  '感谢观看',
  '记得点赞',
  '一键三连',
  '素质三连',
  '长按点赞',
  '谢谢大家',
  '下期再见',
  '我们下期见',
  '欢迎订阅',
  'thanks for watching',
  'please subscribe',
  'like and subscribe',
  '字幕由',
  '字幕制作',
  'subtitles by',
  'amara.org',
];

export interface SpeechTranscriptionRequest extends SpeechTranscribeOptions {
  audioData?: string;
  audioBuffer?: Buffer;
  mimeType: string;
}

interface NormalizedSpeechRequest {
  buffer: Buffer;
  mimeType: string;
  settings: SpeechInputSettings;
  mode: SpeechTranscriptionMode;
  language: string;
  model: string;
  threads: number;
  keepAudioOnFailure: boolean;
  postProcessingEnabled: boolean;
  durationSeconds?: number;
}

function getTextFromTranscriptionResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const text = (result as Record<string, unknown>).text;
  return typeof text === 'string' ? text : '';
}

function isHallucination(text: string): boolean {
  const lowerText = text.toLowerCase();
  return HALLUCINATION_PATTERNS.some((pattern) => lowerText.includes(pattern.toLowerCase()));
}

function getAudioExtension(mimeType: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  if (mimeType.includes('wav')) return '.wav';
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return '.mp3';
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('aac')) return '.aac';
  return '.webm';
}

function getSpeechRetentionDir(): string {
  const dir = path.join(os.tmpdir(), 'code-agent-speech-retained');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupRetainedAudio(): void {
  const dir = getSpeechRetentionDir();
  const cutoff = Date.now() - RETAINED_AUDIO_TTL_MS;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const filePath = path.join(dir, entry);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (error) {
    logger.warn('Failed to cleanup retained speech audio', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function clearRetainedSpeechAudio(): SpeechRetainedAudioClearResult {
  const dir = getSpeechRetentionDir();
  let deletedFiles = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const filePath = path.join(dir, entry);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      fs.unlinkSync(filePath);
      deletedFiles += 1;
    }
  } catch (error) {
    logger.warn('Failed to clear retained speech audio', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { deletedFiles };
}

function normalizeSpeechSettings(settings?: Partial<SpeechInputSettings>): SpeechInputSettings {
  return {
    ...DEFAULT_SPEECH_INPUT_SETTINGS,
    ...(settings ?? {}),
  };
}

function clampThreads(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SPEECH_INPUT_SETTINGS.threads;
  }
  return Math.min(16, Math.max(1, Math.round(value)));
}

function decodeAudioBuffer(request: SpeechTranscriptionRequest): Buffer {
  if (request.audioBuffer) return request.audioBuffer;
  if (!request.audioData) {
    throw new LocalSpeechTranscriptionError('INVALID_ARGS', '未提供音频数据');
  }
  return Buffer.from(request.audioData, 'base64');
}

function normalizeRequest(request: SpeechTranscriptionRequest): NormalizedSpeechRequest {
  const configService = getConfigService();
  const appSettings = configService.getSettings();
  const settings = normalizeSpeechSettings(appSettings.speech);
  const buffer = decodeAudioBuffer(request);
  const mode = request.mode || settings.mode;

  return {
    buffer,
    mimeType: request.mimeType || 'audio/webm',
    settings,
    mode,
    language: request.language || settings.language || DEFAULT_SPEECH_INPUT_SETTINGS.language,
    model: normalizeWhisperModelFileName(request.model || settings.localModel),
    threads: clampThreads(request.threads ?? settings.threads),
    keepAudioOnFailure: request.keepAudioOnFailure ?? settings.preserveAudioOnFailure,
    postProcessingEnabled: settings.postProcessingEnabled,
    durationSeconds: typeof request.durationSeconds === 'number' && Number.isFinite(request.durationSeconds)
      ? Math.max(0, request.durationSeconds)
      : undefined,
  };
}

function makeFailure(
  error: unknown,
  fallbackCode = 'TRANSCRIPTION_FAILED',
  audioPath?: string,
): SpeechTranscribeResult {
  if (error instanceof LocalSpeechTranscriptionError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      recoverable: error.code !== 'INVALID_ARGS' && error.code !== 'ABORTED',
      audioPath,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    error: message || '转写失败',
    code: fallbackCode,
    recoverable: true,
    audioPath,
  };
}

function ensureMeaningfulText(
  rawText: string,
  engine: SpeechTranscriptionEngine,
  meta: Pick<SpeechTranscribeResult, 'durationMs' | 'language' | 'model'>,
  postProcessingEnabled: boolean,
): SpeechTranscribeResult {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return {
      success: false,
      error: '未识别到语音内容',
      code: 'EMPTY_RESULT',
      recoverable: true,
      engine,
      ...meta,
    };
  }

  if (isHallucination(trimmed)) {
    return {
      success: false,
      error: '未识别到有效语音，请重新说话',
      code: 'HALLUCINATION',
      hallucination: true,
      recoverable: true,
      engine,
      ...meta,
    };
  }

  return {
    success: true,
    text: postProcessingEnabled ? postProcessTranscript(trimmed) : trimmed,
    rawText: trimmed,
    engine,
    ...meta,
  };
}

function postProcessTranscript(text: string): string {
  const normalized = text
    .replace(/\b(um|uh|erm|ah)\b/gi, '')
    .replace(/(^|\s)(嗯|呃|啊|呃嗯)(?=\s|，|。|,|\.|$)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。！？,.!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || text.trim();
}

function attachFailureAudio(
  result: SpeechTranscribeResult,
  keepAudioOnFailure: boolean,
  audioPath: string,
): SpeechTranscribeResult {
  if (result.success || !keepAudioOnFailure) return result;
  return { ...result, audioPath };
}

function attachAudioDuration(
  result: SpeechTranscribeResult,
  durationSeconds?: number,
): SpeechTranscribeResult {
  if (durationSeconds === undefined) return result;
  return { ...result, audioDurationSeconds: durationSeconds };
}

function logSpeechTranscriptionResult(
  result: SpeechTranscribeResult,
  request: NormalizedSpeechRequest,
): void {
  logger.info('Speech transcription result', {
    success: result.success,
    code: result.code,
    recoverable: result.recoverable,
    engine: result.engine,
    cloud: result.engine === 'groq',
    mode: request.mode,
    language: result.language || request.language,
    model: result.model || request.model,
    audioDurationSeconds: result.audioDurationSeconds ?? request.durationSeconds,
    durationMs: result.durationMs,
    chunkCount: result.chunkCount,
    bytes: request.buffer.length,
  });
}

function shouldChunkAudio(request: NormalizedSpeechRequest): boolean {
  return request.buffer.length > MAX_SINGLE_PASS_AUDIO_BYTES
    || (request.durationSeconds ?? 0) > CHUNK_AUDIO_AFTER_SECONDS;
}

async function splitAudioIntoChunks(
  inputPath: string,
  outputDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const outputPattern = path.join(outputDir, 'chunk_%03d.wav');
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'segment',
        '-segment_time', String(CHUNK_AUDIO_AFTER_SECONDS),
        '-reset_timestamps', '1',
        '-y',
        outputPattern,
      ],
      { timeout: 120000, signal },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    try {
      await execFileAsync('which', ['ffmpeg'], { signal });
    } catch {
      throw new LocalSpeechTranscriptionError('NOT_INITIALIZED', 'ffmpeg 未安装。请运行: brew install ffmpeg', { cause: error });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new LocalSpeechTranscriptionError('UNKNOWN', `长语音分段失败: ${message}`, { cause: error });
  }

  const chunks = fs.readdirSync(outputDir)
    .filter((entry) => /^chunk_\d+\.wav$/.test(entry))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => path.join(outputDir, entry));

  if (chunks.length === 0) {
    throw new LocalSpeechTranscriptionError('EMPTY_RESULT', '长语音分段结果为空。');
  }

  return chunks;
}

async function transcribeWithGroq(
  filePath: string,
  language: string,
): Promise<string> {
  const apiKey = getConfigService().getApiKey('groq');
  if (!apiKey) {
    throw new LocalSpeechTranscriptionError('NOT_INITIALIZED', '未配置 Groq API Key');
  }

  const groq = new Groq({ apiKey });
  const fileStream = fs.createReadStream(filePath);
  fileStream.on('error', (error) => {
    logger.warn('Groq speech file stream error', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  try {
    const transcription: unknown = await groq.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-large-v3-turbo',
      ...(language && language !== 'auto' ? { language } : {}),
      response_format: 'text',
    });
    return getTextFromTranscriptionResult(transcription);
  } finally {
    fileStream.destroy();
  }
}

async function transcribeAudioFile(
  filePath: string,
  request: NormalizedSpeechRequest,
  failureAudioPath = filePath,
): Promise<SpeechTranscribeResult> {
  const { mode, language, model, threads, keepAudioOnFailure, postProcessingEnabled } = request;

  if (mode !== 'cloud-only') {
    const startedAt = Date.now();
    try {
      const transcript = await transcribeWithWhisperCpp({
        filePath,
        language,
        model,
        threads,
        signal: new AbortController().signal,
        logger,
      });
      return attachFailureAudio(ensureMeaningfulText(transcript.text, 'local-whisper', {
        durationMs: transcript.processingTimeMs || Date.now() - startedAt,
        language: transcript.language,
        model: transcript.model,
      }, postProcessingEnabled), keepAudioOnFailure, failureAudioPath);
    } catch (error) {
      if (mode === 'local-only') {
        return makeFailure(error, 'LOCAL_TRANSCRIPTION_FAILED', keepAudioOnFailure ? failureAudioPath : undefined);
      }
      logger.warn('Local speech transcription failed, trying cloud fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const startedAt = Date.now();
    const text = await transcribeWithGroq(filePath, language);
    return attachFailureAudio(ensureMeaningfulText(text, 'groq', {
      durationMs: Date.now() - startedAt,
      language,
      model: 'whisper-large-v3-turbo',
    }, postProcessingEnabled), keepAudioOnFailure, failureAudioPath);
  } catch (error) {
    return makeFailure(error, 'TRANSCRIPTION_FAILED', keepAudioOnFailure ? failureAudioPath : undefined);
  }
}

function combineSegmentResults(segments: SpeechTranscriptionSegment[]): SpeechTranscribeResult {
  const text = segments.map((segment) => segment.text).filter(Boolean).join('\n').trim();
  const rawText = segments.map((segment) => segment.rawText || segment.text).filter(Boolean).join('\n').trim();
  const first = segments[0];

  return {
    success: true,
    text,
    rawText,
    engine: first?.engine,
    language: first?.language,
    model: first?.model,
    durationMs: segments.reduce((sum, segment) => sum + (segment.durationMs || 0), 0),
    chunkCount: segments.length,
    segments,
  };
}

async function transcribeChunkedAudio(
  filePath: string,
  request: NormalizedSpeechRequest,
): Promise<SpeechTranscribeResult> {
  const chunkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-speech-chunks-'));
  try {
    const chunks = await splitAudioIntoChunks(filePath, chunkDir, new AbortController().signal);
    logger.info('Speech transcription chunked request', {
      chunks: chunks.length,
      durationSeconds: request.durationSeconds,
      size: request.buffer.length,
    });

    const segments: SpeechTranscriptionSegment[] = [];
    for (const [index, chunkPath] of chunks.entries()) {
      const result = await transcribeAudioFile(chunkPath, request, filePath);
      if (!result.success) {
        return {
          ...result,
          chunkCount: chunks.length,
          segments,
        };
      }
      segments.push({
        index,
        text: result.text || '',
        rawText: result.rawText,
        engine: result.engine,
        language: result.language,
        model: result.model,
        durationMs: result.durationMs,
      });
    }

    const combined = combineSegmentResults(segments);
    if (!combined.text) {
      return makeFailure(
        new LocalSpeechTranscriptionError('EMPTY_RESULT', '未识别到语音内容'),
        'EMPTY_RESULT',
        request.keepAudioOnFailure ? filePath : undefined,
      );
    }
    return combined;
  } finally {
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch (error) {
      logger.warn('Failed to clean up speech chunks', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export class SpeechTranscriptionService {
  async transcribe(request: SpeechTranscriptionRequest): Promise<SpeechTranscribeResult> {
    let normalized: NormalizedSpeechRequest;
    try {
      normalized = normalizeRequest(request);
    } catch (error) {
      return makeFailure(error, 'INVALID_ARGS');
    }

    const { buffer, mimeType, settings, mode, language, model, keepAudioOnFailure } = normalized;

    if (!settings.enabled && request.source === 'composer') {
      const result = {
        success: false,
        error: '语音输入已关闭',
        code: 'DISABLED',
        recoverable: false,
      };
      logSpeechTranscriptionResult(result, normalized);
      return result;
    }

    if (buffer.length > MAX_COMPOSER_AUDIO_BYTES) {
      const result = attachAudioDuration({
        success: false,
        error: '音频文件过大（最大 50MB）',
        code: 'AUDIO_TOO_LARGE',
        recoverable: false,
      }, normalized.durationSeconds);
      logSpeechTranscriptionResult(result, normalized);
      return result;
    }

    if (buffer.length < MIN_COMPOSER_AUDIO_BYTES) {
      const result = attachAudioDuration({
        success: false,
        error: '录音时间太短，请说话后再松手',
        code: 'AUDIO_TOO_SHORT',
        recoverable: true,
      }, normalized.durationSeconds);
      logSpeechTranscriptionResult(result, normalized);
      return result;
    }

    if (keepAudioOnFailure) {
      cleanupRetainedAudio();
    }
    const tempDir = keepAudioOnFailure ? getSpeechRetentionDir() : os.tmpdir();
    const tempFile = path.join(tempDir, `speech_${Date.now()}_${Math.random().toString(36).slice(2)}${getAudioExtension(mimeType)}`);
    let shouldKeepTempFile: boolean | undefined;

    try {
      fs.writeFileSync(tempFile, buffer);
      logger.info('Speech transcription request', {
        size: buffer.length,
        mimeType,
        mode,
        language,
        model,
      });

      const result = shouldChunkAudio(normalized)
        ? await transcribeChunkedAudio(tempFile, normalized)
        : await transcribeAudioFile(tempFile, normalized);
      const resultWithAudioDuration = attachAudioDuration(result, normalized.durationSeconds);
      shouldKeepTempFile = Boolean(resultWithAudioDuration.audioPath);
      logSpeechTranscriptionResult(resultWithAudioDuration, normalized);
      return resultWithAudioDuration;
    } catch (error) {
      shouldKeepTempFile = keepAudioOnFailure;
      const result = attachAudioDuration(
        makeFailure(error, 'TRANSCRIPTION_FAILED', shouldKeepTempFile ? tempFile : undefined),
        normalized.durationSeconds,
      );
      logSpeechTranscriptionResult(result, normalized);
      return result;
    } finally {
      if (!shouldKeepTempFile && fs.existsSync(tempFile)) {
        try {
          fs.unlinkSync(tempFile);
        } catch (error) {
          logger.warn('Failed to clean up speech temp file', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}

let speechTranscriptionService: SpeechTranscriptionService | null = null;

export function getSpeechTranscriptionService(): SpeechTranscriptionService {
  if (!speechTranscriptionService) {
    speechTranscriptionService = new SpeechTranscriptionService();
  }
  return speechTranscriptionService;
}
