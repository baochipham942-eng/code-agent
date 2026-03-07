// ============================================================================
// Text to Speech Tool - 语音合成
// 使用智谱 GLM-TTS 模型
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('TextToSpeech');

// 配置
const CONFIG = {
  API_URL: 'https://open.bigmodel.cn/api/paas/v4/audio/speech',
  MODEL: 'glm-tts',
  TIMEOUT_MS: 60000, // 60 秒超时
  MAX_TEXT_LENGTH: 2000, // 最大文本长度
  DEFAULT_VOICE: 'female',
  DEFAULT_SPEED: 1.0,
  DEFAULT_VOLUME: 1.0,
  DEFAULT_FORMAT: 'wav',
};

// 可用的声音选项
const AVAILABLE_VOICES = [
  'female', // 默认女声
  '彤彤', // 活泼女声
  '小陈', // 成熟男声
  '锤锤', // 可爱童声
  'jam', // 英文男声
  'kazi', // 英文女声
  'douji', // 方言男声
  'luodo', // 低沉男声
] as const;

type VoiceType = (typeof AVAILABLE_VOICES)[number];

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

interface TextToSpeechParams {
  text: string;
  output_path?: string;
  voice?: VoiceType;
  speed?: number; // 0.5 - 2.0
  volume?: number; // 0.5 - 2.0
  format?: 'wav' | 'pcm';
}

/**
 * 调用智谱 TTS API
 */
async function callZhipuTTS(
  apiKey: string,
  params: TextToSpeechParams
): Promise<Buffer> {
  const requestBody = {
    model: CONFIG.MODEL,
    input: params.text,
    voice: params.voice || CONFIG.DEFAULT_VOICE,
    speed: params.speed ?? CONFIG.DEFAULT_SPEED,
    volume: params.volume ?? CONFIG.DEFAULT_VOLUME,
    response_format: params.format || CONFIG.DEFAULT_FORMAT,
  };

  logger.info('[语音合成] 调用智谱 TTS API', {
    textLength: params.text.length,
    voice: requestBody.voice,
    speed: requestBody.speed,
    format: requestBody.response_format,
  });

  const response = await fetchWithTimeout(
    CONFIG.API_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    CONFIG.TIMEOUT_MS
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`智谱 TTS API 错误: ${response.status} - ${errorText}`);
  }

  // 返回音频数据
  const arrayBuffer = await response.arrayBuffer();
  const audioData = Buffer.from(arrayBuffer);

  logger.info('[语音合成] 合成成功', {
    audioSize: audioData.length,
  });

  return audioData;
}

/**
 * 验证参数
 */
function validateParams(params: TextToSpeechParams): void {
  // 检查文本长度
  if (params.text.length > CONFIG.MAX_TEXT_LENGTH) {
    throw new Error(
      `文本过长: ${params.text.length} 字符。最大支持 ${CONFIG.MAX_TEXT_LENGTH} 字符`
    );
  }

  if (params.text.trim().length === 0) {
    throw new Error('文本不能为空');
  }

  // 检查语速
  if (params.speed !== undefined && (params.speed < 0.5 || params.speed > 2.0)) {
    throw new Error('语速必须在 0.5 - 2.0 之间');
  }

  // 检查音量
  if (params.volume !== undefined && (params.volume < 0.5 || params.volume > 2.0)) {
    throw new Error('音量必须在 0.5 - 2.0 之间');
  }

  // 检查声音类型
  if (params.voice && !AVAILABLE_VOICES.includes(params.voice)) {
    throw new Error(
      `不支持的声音类型: ${params.voice}。可选: ${AVAILABLE_VOICES.join(', ')}`
    );
  }
}

export const textToSpeechTool: Tool = {
  name: 'text_to_speech',
  description: `语音合成。

使用智谱 GLM-TTS 模型将文字转为语音。

参数：
- text: 要合成的文本（必填，最长 ${CONFIG.MAX_TEXT_LENGTH} 字符）
- output_path: 输出文件路径（可选，不填则返回 base64）
- voice: 声音类型（可选，默认 female）
- speed: 语速 0.5-2.0（可选，默认 1.0）
- volume: 音量 0.5-2.0（可选，默认 1.0）
- format: 输出格式 wav/pcm（可选，默认 wav）

可用声音：
- female: 默认女声
- 彤彤: 活泼女声
- 小陈: 成熟男声
- 锤锤: 可爱童声
- jam: 英文男声
- kazi: 英文女声
- douji: 方言男声
- luodo: 低沉男声

示例：
\`\`\`
text_to_speech { "text": "你好，欢迎使用语音合成" }
text_to_speech { "text": "Hello world", "voice": "jam", "output_path": "./hello.wav" }
text_to_speech { "text": "快速播报", "speed": 1.5, "voice": "小陈" }
\`\`\`

注意：需要配置智谱 API Key`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要合成的文本',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（不填返回 base64）',
      },
      voice: {
        type: 'string',
        enum: AVAILABLE_VOICES as unknown as string[],
        description: '声音类型（默认 female）',
      },
      speed: {
        type: 'number',
        description: '语速 0.5-2.0（默认 1.0）',
      },
      volume: {
        type: 'number',
        description: '音量 0.5-2.0（默认 1.0）',
      },
      format: {
        type: 'string',
        enum: ['wav', 'pcm'],
        description: '输出格式（默认 wav）',
      },
    },
    required: ['text'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const typedParams = params as unknown as TextToSpeechParams;
    const startTime = Date.now();

    try {
      const configService = getConfigService();
      const zhipuApiKey = configService.getApiKey('zhipu');

      if (!zhipuApiKey) {
        return {
          success: false,
          error: '语音合成需要配置智谱 API Key。请在设置中添加智谱 API Key。',
        };
      }

      // 验证参数
      validateParams(typedParams);

      context.emit?.('tool_output', {
        tool: 'text_to_speech',
        message: `🔊 正在合成语音 (${typedParams.text.length} 字符)...`,
      });

      // 调用 TTS API
      const audioData = await callZhipuTTS(zhipuApiKey, typedParams);

      const processingTime = Date.now() - startTime;
      const format = typedParams.format || CONFIG.DEFAULT_FORMAT;

      // 处理输出
      let outputPath: string | undefined;
      let output: string;

      if (typedParams.output_path) {
        // 保存到文件
        outputPath = path.isAbsolute(typedParams.output_path)
          ? typedParams.output_path
          : path.join(context.workingDirectory, typedParams.output_path);

        // 确保目录存在
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // 确保文件有正确的扩展名
        if (!outputPath.endsWith(`.${format}`)) {
          outputPath = `${outputPath}.${format}`;
        }

        fs.writeFileSync(outputPath, audioData);
        output = `语音合成成功，已保存到: ${outputPath}`;
        logger.info('[语音合成] 文件已保存', { path: outputPath });
      } else {
        // 返回 base64
        const base64Audio = audioData.toString('base64');
        output = `语音合成成功。\n音频数据 (base64, ${format}): ${base64Audio.substring(0, 100)}...`;
      }

      return {
        success: true,
        output,
        metadata: {
          outputPath,
          textLength: typedParams.text.length,
          audioSizeBytes: audioData.length,
          voice: typedParams.voice || CONFIG.DEFAULT_VOICE,
          speed: typedParams.speed ?? CONFIG.DEFAULT_SPEED,
          format,
          processingTimeMs: processingTime,
          model: CONFIG.MODEL,
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[语音合成] 失败', { error: message });
      return {
        success: false,
        error: `语音合成失败: ${message}`,
      };
    }
  },
};
