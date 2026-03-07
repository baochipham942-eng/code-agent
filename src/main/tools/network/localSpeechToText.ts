// ============================================================================
// Local Speech to Text Tool - 本地离线语音转文字
// 使用 whisper-cpp 作为推理后端
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { createLogger } from '../../services/infra/logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('LocalSpeechToText');

// 配置
const CONFIG = {
  WHISPER_PATHS: ['/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp'],
  MODEL_DIR: path.join(process.env.HOME || '~', '.cache', 'whisper'),
  DEFAULT_MODEL: 'ggml-large-v3-turbo.bin',
  DEFAULT_LANGUAGE: 'zh',
  DEFAULT_THREADS: 4,
  TIMEOUT_MS: 300000, // 5 分钟超时
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

/**
 * 查找 whisper-cpp 可执行文件
 */
async function findWhisperBinary(): Promise<string | null> {
  // 检查已知路径
  for (const p of CONFIG.WHISPER_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  // 尝试 which
  try {
    const { stdout } = await execFileAsync('which', ['whisper-cpp']);
    const trimmed = stdout.trim();
    if (trimmed && fs.existsSync(trimmed)) return trimmed;
  } catch {
    // not found
  }

  return null;
}

/**
 * 获取模型文件路径
 */
function getModelPath(modelName: string): string {
  // 如果已包含 ggml- 前缀和 .bin 后缀，直接使用
  if (modelName.startsWith('ggml-') && modelName.endsWith('.bin')) {
    return path.join(CONFIG.MODEL_DIR, modelName);
  }
  // 否则拼接标准文件名
  return path.join(CONFIG.MODEL_DIR, `ggml-${modelName}.bin`);
}

/**
 * 将音频转换为 16kHz mono WAV（whisper-cpp 要求）
 */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  try {
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ar', String(CONFIG.WAV_SAMPLE_RATE),
      '-ac', '1',
      '-f', 'wav',
      '-y',
      outputPath,
    ], { timeout: 60000 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // 检查 ffmpeg 是否存在
    try {
      await execFileAsync('which', ['ffmpeg']);
    } catch {
      throw new Error('ffmpeg 未安装。请运行: brew install ffmpeg');
    }
    throw new Error(`音频转换失败: ${message}`);
  }
}

/**
 * 解析 whisper-cpp 输出，提取纯文本
 */
function parseWhisperOutput(stdout: string, format: string): string {
  if (format === 'srt' || format === 'vtt') {
    return stdout.trim();
  }

  // text 模式：去除时间戳行，只保留文本内容
  const lines = stdout.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // whisper-cpp 输出格式: [00:00:00.000 --> 00:00:05.000]  文本内容
    const match = trimmed.match(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/);
    if (match && match[1]) {
      textLines.push(match[1].trim());
    } else if (trimmed && !trimmed.startsWith('[')) {
      // 纯文本行
      textLines.push(trimmed);
    }
  }

  return textLines.join('\n').trim();
}

export const localSpeechToTextTool: Tool = {
  name: 'local_speech_to_text',
  description: `本地离线语音转文字。

使用 whisper-cpp 在本地运行语音识别，无需网络，支持多种语言。

参数：
- file_path: 音频文件路径（必填）
- language: 语言代码，如 zh/en/ja（可选，默认 zh）
- model: 模型名称（可选，默认 large-v3-turbo）
- threads: CPU 线程数（可选，默认 4）
- output_format: 输出格式 text/srt/vtt（可选，默认 text）
- translate: 是否翻译为英文（可选）

支持格式：${CONFIG.SUPPORTED_FORMATS.join(', ')}
非 WAV 格式会自动通过 ffmpeg 转换。

前置要求：
- brew install whisper-cpp
- 模型文件放置于 ~/.cache/whisper/

示例：
\`\`\`
local_speech_to_text { "file_path": "/path/to/audio.wav" }
local_speech_to_text { "file_path": "meeting.mp3", "language": "en", "output_format": "srt" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '音频文件路径',
      },
      language: {
        type: 'string',
        description: '语言代码（如 zh, en, ja），默认 zh',
      },
      model: {
        type: 'string',
        description: '模型名称，默认 large-v3-turbo',
      },
      threads: {
        type: 'number',
        description: 'CPU 线程数，默认 4',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'srt', 'vtt'],
        description: '输出格式，默认 text',
      },
      translate: {
        type: 'boolean',
        description: '是否翻译为英文',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const typedParams = params as unknown as LocalSpeechToTextParams;
    const startTime = Date.now();

    try {
      // 1. 检查 whisper-cpp
      const whisperBin = await findWhisperBinary();
      if (!whisperBin) {
        return {
          success: false,
          error: 'whisper-cpp 未安装。请运行: brew install whisper-cpp',
        };
      }

      // 2. 解析文件路径
      let filePath = typedParams.file_path;
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(context.workingDirectory, filePath);
      }

      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: `文件不存在: ${filePath}`,
        };
      }

      // 3. 验证格式
      const ext = path.extname(filePath).toLowerCase();
      if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
        return {
          success: false,
          error: `不支持的音频格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
        };
      }

      // 4. 检查模型
      const modelName = typedParams.model
        ? (typedParams.model.startsWith('ggml-') ? typedParams.model : `ggml-${typedParams.model}`)
        : CONFIG.DEFAULT_MODEL;
      const modelPath = getModelPath(modelName);

      if (!fs.existsSync(modelPath)) {
        return {
          success: false,
          error: `模型文件不存在: ${modelPath}\n\n请下载模型:\ncurl -L -o ${modelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${path.basename(modelPath)}`,
        };
      }

      const language = typedParams.language || CONFIG.DEFAULT_LANGUAGE;
      const threads = typedParams.threads || CONFIG.DEFAULT_THREADS;
      const outputFormat = typedParams.output_format || 'text';

      context.emit?.('tool_output', {
        tool: 'local_speech_to_text',
        message: `正在转写语音 (模型: ${path.basename(modelPath)}, 语言: ${language})...`,
      });

      // 5. 如果不是 WAV，先转换
      let wavPath = filePath;
      let tempWav = false;

      if (ext !== '.wav') {
        wavPath = path.join(path.dirname(filePath), `_whisper_temp_${Date.now()}.wav`);
        tempWav = true;

        context.emit?.('tool_output', {
          tool: 'local_speech_to_text',
          message: `正在转换 ${ext} → WAV...`,
        });

        await convertToWav(filePath, wavPath);
      }

      try {
        // 6. 构建 whisper-cpp 参数
        const args: string[] = [
          '-m', modelPath,
          '-f', wavPath,
          '-l', language,
          '-t', String(threads),
          '--no-prints',
        ];

        if (outputFormat === 'srt') {
          args.push('--output-srt');
        } else if (outputFormat === 'vtt') {
          args.push('--output-vtt');
        }

        if (typedParams.translate) {
          args.push('--translate');
        }

        logger.info('[本地语音转文字] 开始转写', {
          file: path.basename(filePath),
          model: path.basename(modelPath),
          language,
          threads,
        });

        // 7. 执行转写
        const { stdout, stderr } = await execFileAsync(whisperBin, args, {
          timeout: CONFIG.TIMEOUT_MS,
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer
        });

        if (stderr) {
          logger.warn('[本地语音转文字] stderr', { stderr: stderr.substring(0, 500) });
        }

        // 8. 解析输出
        const text = parseWhisperOutput(stdout, outputFormat);

        if (!text) {
          return {
            success: false,
            error: '转写结果为空，可能音频中没有可识别的语音内容。',
          };
        }

        const processingTime = Date.now() - startTime;

        logger.info('[本地语音转文字] 转写完成', {
          textLength: text.length,
          processingTimeMs: processingTime,
        });

        return {
          success: true,
          output: text,
          metadata: {
            filePath,
            model: path.basename(modelPath),
            language,
            outputFormat,
            textLength: text.length,
            processingTimeMs: processingTime,
          },
        };
      } finally {
        // 清理临时 WAV 文件
        if (tempWav && fs.existsSync(wavPath)) {
          try {
            fs.unlinkSync(wavPath);
          } catch {
            // ignore cleanup errors
          }
        }
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('[本地语音转文字] 失败', { error: errMsg });

      // 超时特殊提示
      if ((error as Record<string, unknown>).killed || (error as Record<string, unknown>).signal === 'SIGTERM') {
        return {
          success: false,
          error: `转写超时（超过 ${CONFIG.TIMEOUT_MS / 1000} 秒）。可尝试：\n- 使用更小的模型（如 base 或 small）\n- 增加线程数\n- 分割长音频`,
        };
      }

      return {
        success: false,
        error: `本地语音转文字失败: ${errMsg}`,
      };
    }
  },
};
