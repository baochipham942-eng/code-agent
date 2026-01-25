// ============================================================================
// Speech to Text Tool - 语音转文字
// 使用智谱 GLM-ASR-2512 模型
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('SpeechToText');

// 配置
const CONFIG = {
  API_URL: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
  MODEL: 'glm-asr-2512',
  TIMEOUT_MS: 60000, // 60 秒超时
  MAX_FILE_SIZE_MB: 25,
  MAX_DURATION_SECONDS: 30,
  SUPPORTED_FORMATS: ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm'],
};

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface SpeechToTextParams {
  file_path: string;
  hotwords?: string; // 热词，用于提高识别准确率
  prompt?: string; // 上下文提示
}

interface ZhipuASRResponse {
  id?: string;
  text?: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 调用智谱 ASR API
 */
async function callZhipuASR(
  apiKey: string,
  audioData: Buffer,
  fileName: string,
  params: SpeechToTextParams
): Promise<string> {
  // 使用 base64 方式发送，避免 Buffer/Blob 类型兼容问题
  const base64Audio = audioData.toString('base64');
  const mimeType = getMimeType(fileName);

  // 直接发送 JSON 请求而非 FormData
  const jsonBody = {
    model: CONFIG.MODEL,
    file: `data:${mimeType};base64,${base64Audio}`,
    stream: false,
    ...(params.hotwords && { hotwords: params.hotwords }),
    ...(params.prompt && { prompt: params.prompt }),
  };

  logger.info('[语音转文字] 调用智谱 ASR API', {
    fileName: path.basename(fileName),
    fileSize: audioData.length,
    hasHotwords: !!params.hotwords,
    hasPrompt: !!params.prompt,
  });

  const response = await fetchWithTimeout(
    CONFIG.API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(jsonBody),
    },
    CONFIG.TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`智谱 ASR API 错误: ${response.status} - ${errorText}`);
  }

  const result: ZhipuASRResponse = await response.json();

  if (result.error) {
    throw new Error(`ASR 错误: ${result.error.message} (${result.error.code})`);
  }

  if (!result.text) {
    throw new Error('ASR 未返回识别结果');
  }

  logger.info('[语音转文字] 识别成功', {
    textLength: result.text.length,
  });

  return result.text;
}

/**
 * 获取音频文件的 MIME 类型
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
  };
  return mimeTypes[ext] || 'audio/wav';
}

/**
 * 验证文件
 */
function validateFile(filePath: string, stats: fs.Stats): void {
  // 检查扩展名
  const ext = path.extname(filePath).toLowerCase();
  if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
    throw new Error(
      `不支持的音频格式: ${ext}。支持的格式: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`
    );
  }

  // 检查文件大小
  const sizeMB = stats.size / (1024 * 1024);
  if (sizeMB > CONFIG.MAX_FILE_SIZE_MB) {
    throw new Error(
      `文件过大: ${sizeMB.toFixed(2)} MB。最大支持 ${CONFIG.MAX_FILE_SIZE_MB} MB`
    );
  }
}

export const speechToTextTool: Tool = {
  name: 'speech_to_text',
  description: `语音转文字。

使用智谱 GLM-ASR-2512 模型将音频转为文字。

参数：
- file_path: 音频文件路径（必填）
- hotwords: 热词列表，用于提高特定词汇识别率（可选）
- prompt: 上下文提示，帮助模型理解内容（可选）

支持格式：${CONFIG.SUPPORTED_FORMATS.join(', ')}
限制：最大 ${CONFIG.MAX_FILE_SIZE_MB}MB，最长 ${CONFIG.MAX_DURATION_SECONDS} 秒

示例：
\`\`\`
speech_to_text { "file_path": "/path/to/audio.wav" }
speech_to_text { "file_path": "meeting.mp3", "hotwords": "智谱,GLM,API" }
speech_to_text { "file_path": "lecture.wav", "prompt": "这是一段关于人工智能的讲座" }
\`\`\`

注意：需要配置智谱 API Key`,
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
      hotwords: {
        type: 'string',
        description: '热词列表，逗号分隔，用于提高特定词汇识别率',
      },
      prompt: {
        type: 'string',
        description: '上下文提示，帮助模型理解内容',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const typedParams = params as unknown as SpeechToTextParams;
    const startTime = Date.now();

    try {
      const configService = getConfigService();
      const zhipuApiKey = configService.getApiKey('zhipu');

      if (!zhipuApiKey) {
        return {
          success: false,
          error: '语音转文字需要配置智谱 API Key。请在设置中添加智谱 API Key。',
        };
      }

      // 解析文件路径
      let filePath = typedParams.file_path;
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(context.workingDirectory, filePath);
      }

      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          error: `文件不存在: ${filePath}`,
        };
      }

      // 验证文件
      const stats = fs.statSync(filePath);
      validateFile(filePath, stats);

      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      context.emit?.('tool_output', {
        tool: 'speech_to_text',
        message: `🎤 正在识别语音 (${fileSizeMB} MB)...`,
      });

      // 读取文件
      const audioData = fs.readFileSync(filePath);

      // 调用 ASR API
      const text = await callZhipuASR(zhipuApiKey, audioData, filePath, typedParams);

      const processingTime = Date.now() - startTime;

      return {
        success: true,
        output: text,
        metadata: {
          filePath,
          fileSizeMB: parseFloat(fileSizeMB),
          textLength: text.length,
          processingTimeMs: processingTime,
          model: CONFIG.MODEL,
        },
      };
    } catch (error: any) {
      logger.error('[语音转文字] 失败', { error: error.message });
      return {
        success: false,
        error: `语音转文字失败: ${error.message}`,
      };
    }
  },
};
