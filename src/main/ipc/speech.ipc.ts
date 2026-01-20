// ============================================================================
// Speech IPC - 语音转写 IPC 处理器
// 使用 Groq Whisper API 进行语音转文字
// ============================================================================

import { ipcMain, IpcMain } from 'electron';
import Groq from 'groq-sdk';
import { createLogger } from '../services/infra/logger';
import { getConfigService } from '../services/core/configService';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const logger = createLogger('Speech');

// IPC 通道名称
export const SPEECH_CHANNELS = {
  TRANSCRIBE: 'speech:transcribe',
} as const;

// Groq API Key (通过 ConfigService 获取)
// 优先级：secure storage > config.json > 环境变量
function getGroqApiKey(): string | undefined {
  const configService = getConfigService();
  return configService.getApiKey('groq');
}

// Whisper 幻觉过滤列表
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

/**
 * 检测是否为 Whisper 幻觉输出
 */
function isHallucination(text: string): boolean {
  const lowerText = text.toLowerCase();
  return HALLUCINATION_PATTERNS.some(pattern =>
    lowerText.includes(pattern.toLowerCase())
  );
}

/**
 * 使用 Groq Whisper 进行语音转文字
 */
async function transcribeWithGroq(audioBuffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error('未配置 Groq API Key');
  }

  const groq = new Groq({ apiKey });

  // 根据 MIME 类型确定文件扩展名
  let ext = '.webm';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) {
    ext = '.m4a';
  } else if (mimeType.includes('wav')) {
    ext = '.wav';
  } else if (mimeType.includes('mp3') || mimeType.includes('mpeg')) {
    ext = '.mp3';
  }

  // 创建临时文件
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `speech_${Date.now()}${ext}`);

  try {
    // 写入临时文件
    fs.writeFileSync(tempFile, audioBuffer);

    // 创建文件流
    const fileStream = fs.createReadStream(tempFile);

    const startTime = Date.now();
    logger.info('Starting Groq Whisper transcription...', { size: audioBuffer.length, mimeType });

    const transcription = await groq.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-large-v3-turbo',
      language: 'zh',
      response_format: 'text',
    });

    logger.info(`Groq transcription completed in ${Date.now() - startTime}ms`);

    return typeof transcription === 'string'
      ? transcription
      : (transcription as any).text || '';

  } finally {
    // 清理临时文件
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      logger.warn('Failed to clean up temp file:', e);
    }
  }
}

/**
 * 语音转写请求参数
 */
export interface TranscribeRequest {
  audioData: string;  // Base64 编码的音频数据
  mimeType: string;   // MIME 类型，如 'audio/webm;codecs=opus'
}

/**
 * 语音转写响应
 */
export interface TranscribeResponse {
  success: boolean;
  text?: string;
  error?: string;
  hallucination?: boolean;
}

/**
 * 注册语音相关的 IPC 处理器
 */
export function registerSpeechHandlers(ipcMain: IpcMain): void {
  // 语音转写
  ipcMain.handle(
    SPEECH_CHANNELS.TRANSCRIBE,
    async (_event, request: TranscribeRequest): Promise<TranscribeResponse> => {
      try {
        const { audioData, mimeType } = request;

        if (!audioData) {
          return { success: false, error: '未提供音频数据' };
        }

        // 解码 Base64 音频数据
        const audioBuffer = Buffer.from(audioData, 'base64');

        // 验证音频大小
        if (audioBuffer.length > 10 * 1024 * 1024) {
          return { success: false, error: '音频文件过大（最大 10MB）' };
        }

        if (audioBuffer.length < 500) {
          return { success: false, error: '录音时间太短，请说话后再松手' };
        }

        logger.info('Received audio for transcription:', {
          size: audioBuffer.length,
          mimeType,
        });

        // 执行转写
        const text = await transcribeWithGroq(audioBuffer, mimeType);

        if (!text || text.trim().length === 0) {
          return { success: false, error: '未识别到语音内容' };
        }

        // 检测幻觉
        if (isHallucination(text)) {
          logger.warn('Detected Whisper hallucination, ignoring:', text);
          return {
            success: false,
            error: '未识别到有效语音，请重新说话',
            hallucination: true
          };
        }

        logger.info('Transcription result:', text.substring(0, 50) + (text.length > 50 ? '...' : ''));
        return { success: true, text: text.trim() };

      } catch (error) {
        logger.error('Transcription error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : '转写失败'
        };
      }
    }
  );

  logger.info('Speech handlers registered');
}
