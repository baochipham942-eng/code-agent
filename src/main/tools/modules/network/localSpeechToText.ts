// ============================================================================
// local_speech_to_text (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy LocalSpeechToTextTool 迁移到 native：whisper-cpp 本地推理 +
// ffmpeg 自动转 16kHz mono WAV。**真正的 binary spawn**（不像 sharp 那样
// 是 node binding），所以 abort signal 直接传给 execFile 的 signal option，
// abort 时 Node 会自动 SIGTERM 子进程 —— 比 lsp 的 race-and-abandon 更彻底，
// 因为 ffmpeg/whisper-cpp 是 per-call 短期进程，没有共享状态可保留。
//
// 行为保真：legacy 中文文案、whisper-cpp 输出解析（去时间戳行）、临时 WAV
// 清理 finally 钩子、超时特殊提示 1:1 复刻。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { localSpeechToTextSchema as schema } from './localSpeechToText.schema';

const execFileAsync = promisify(execFile);

const CONFIG = {
  WHISPER_PATHS: ['/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'],
  MODEL_DIR: path.join(process.env.HOME || '~', '.cache', 'whisper'),
  DEFAULT_MODEL: 'ggml-large-v3-turbo.bin',
  DEFAULT_LANGUAGE: 'zh',
  DEFAULT_THREADS: 4,
  TIMEOUT_MS: 300000,
  SUPPORTED_FORMATS: ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm', '.aac', '.wma'],
  WAV_SAMPLE_RATE: 16000,
};

interface LocalSpeechToTextParams {
  file_path: string;
  language?: string;
  model?: string;
  threads?: number;
  output_format?: 'text' | 'srt' | 'vtt';
  translate?: boolean;
}

async function findWhisperBinary(signal: AbortSignal): Promise<string | null> {
  for (const p of CONFIG.WHISPER_PATHS) {
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

function getModelPath(modelName: string): string {
  if (modelName.startsWith('ggml-') && modelName.endsWith('.bin')) {
    return path.join(CONFIG.MODEL_DIR, modelName);
  }
  return path.join(CONFIG.MODEL_DIR, `ggml-${modelName}.bin`);
}

async function convertToWav(
  inputPath: string,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      ['-i', inputPath, '-ar', String(CONFIG.WAV_SAMPLE_RATE), '-ac', '1', '-f', 'wav', '-y', outputPath],
      { timeout: 60000, signal },
    );
  } catch (error: unknown) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await execFileAsync('which', ['ffmpeg'], { signal });
    } catch {
      throw new Error('ffmpeg 未安装。请运行: brew install ffmpeg');
    }
    throw new Error(`音频转换失败: ${message}`);
  }
}

function parseWhisperOutput(stdout: string, format: string): string {
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

export async function executeLocalSpeechToText(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const params = args as unknown as LocalSpeechToTextParams;
  if (typeof params.file_path !== 'string' || params.file_path.length === 0) {
    return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();

  try {
    const whisperBin = await findWhisperBinary(ctx.abortSignal);
    if (!whisperBin) {
      return {
        ok: false,
        error: 'whisper-cpp 未安装。请运行: brew install whisper-cpp',
        code: 'NOT_INITIALIZED',
      };
    }

    let filePath = params.file_path;
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(ctx.workingDir, filePath);
    }

    if (!fs.existsSync(filePath)) {
      return { ok: false, error: `文件不存在: ${filePath}`, code: 'FS_ERROR' };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
      return {
        ok: false,
        error: `不支持的音频格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
        code: 'INVALID_ARGS',
      };
    }

    const modelName = params.model
      ? params.model.startsWith('ggml-')
        ? params.model
        : `ggml-${params.model}`
      : CONFIG.DEFAULT_MODEL;
    const modelPath = getModelPath(modelName);

    if (!fs.existsSync(modelPath)) {
      return {
        ok: false,
        error: `模型文件不存在: ${modelPath}\n\n请下载模型:\ncurl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(modelPath)}`,
        code: 'NOT_INITIALIZED',
      };
    }

    const language = params.language || CONFIG.DEFAULT_LANGUAGE;
    const threads = params.threads || CONFIG.DEFAULT_THREADS;
    const outputFormat = params.output_format || 'text';

    ctx.emit({
      type: 'tool_output',
      tool: 'local_speech_to_text',
      message: `正在转写语音 (模型: ${path.basename(modelPath)}, 语言: ${language})...`,
    } as never);

    let wavPath = filePath;
    let tempWav = false;

    if (ext !== '.wav') {
      wavPath = path.join(path.dirname(filePath), `_whisper_temp_${Date.now()}.wav`);
      tempWav = true;
      ctx.emit({
        type: 'tool_output',
        tool: 'local_speech_to_text',
        message: `正在转换 ${ext} → WAV...`,
      } as never);
      await convertToWav(filePath, wavPath, ctx.abortSignal);
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
      if (params.translate) {
        whisperArgs.push('--translate');
      }

      ctx.logger.debug('local_speech_to_text whisper-cpp start', {
        file: path.basename(filePath),
        model: path.basename(modelPath),
        language,
        threads,
      });

      const { stdout, stderr } = await execFileAsync(whisperBin, whisperArgs, {
        timeout: CONFIG.TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
        signal: ctx.abortSignal,
      });

      if (stderr) {
        ctx.logger.debug('local_speech_to_text stderr', { stderr: stderr.substring(0, 500) });
      }

      const text = parseWhisperOutput(stdout, outputFormat);
      if (!text) {
        return {
          ok: false,
          error: '转写结果为空，可能音频中没有可识别的语音内容。',
          code: 'EMPTY_RESULT',
        };
      }

      const processingTime = Date.now() - startTime;

      onProgress?.({ stage: 'completing', percent: 100 });

      return {
        ok: true,
        output: text,
        meta: {
          filePath,
          model: path.basename(modelPath),
          language,
          outputFormat,
          textLength: text.length,
          processingTimeMs: processingTime,
        },
      };
    } finally {
      if (tempWav && fs.existsSync(wavPath)) {
        try {
          fs.unlinkSync(wavPath);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('local_speech_to_text failed', { error: errMsg });
    const errMeta = error as Record<string, unknown>;
    if (errMeta.killed || errMeta.signal === 'SIGTERM') {
      return {
        ok: false,
        error: `转写超时（超过 ${CONFIG.TIMEOUT_MS / 1000} 秒）。可尝试：\n- 使用更小的模型（如 base 或 small）\n- 增加线程数\n- 分割长音频`,
        code: 'TIMEOUT',
      };
    }
    return { ok: false, error: `本地语音转文字失败: ${errMsg}` };
  }
}

class LocalSpeechToTextHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeLocalSpeechToText(args, ctx, canUseTool, onProgress);
  }
}

export const localSpeechToTextModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new LocalSpeechToTextHandler();
  },
};
