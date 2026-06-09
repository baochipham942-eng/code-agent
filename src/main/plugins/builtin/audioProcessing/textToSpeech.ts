// ============================================================================
// text_to_speech (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy TextToSpeechTool 迁移到 native：智谱 GLM-TTS 调用、参数验证、
// 文件保存或 base64 返回。abort 走 race-and-abandon。
//
// 行为保真：legacy 中文文案、emoji（🔊）、AVAILABLE_VOICES 枚举、speed/volume
// 边界检查（0.5-2.0）、metadata 形状 1:1 复刻。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getConfigService } from '../../../services';
import { createFileArtifact, createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { MODEL_API_ENDPOINTS } from '../../../../shared/constants';
import { textToSpeechSchema as schema } from './textToSpeech.schema';
import { TOOL_DEPENDENCY_HINTS } from '../../../tools/modules/_helpers/dependencyHints';

const CONFIG = {
  API_URL: `${MODEL_API_ENDPOINTS.zhipuOfficial}/audio/speech`,
  MODEL: 'glm-tts',
  TIMEOUT_MS: 60000,
  MAX_TEXT_LENGTH: 2000,
  DEFAULT_VOICE: 'female',
  DEFAULT_SPEED: 1.0,
  DEFAULT_VOLUME: 1.0,
  DEFAULT_FORMAT: 'wav' as const,
};

const AVAILABLE_VOICES = [
  'female',
  '彤彤',
  '小陈',
  '锤锤',
  'jam',
  'kazi',
  'douji',
  'luodo',
] as const;

type VoiceType = (typeof AVAILABLE_VOICES)[number];

interface TextToSpeechParams {
  text: string;
  output_path?: string;
  voice?: VoiceType;
  speed?: number;
  volume?: number;
  format?: 'wav' | 'pcm';
}

async function fetchWithAbort(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener('abort', onOuterAbort);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

function validateParams(params: TextToSpeechParams): string | null {
  if (params.text.length > CONFIG.MAX_TEXT_LENGTH) {
    return `文本过长: ${params.text.length} 字符。最大支持 ${CONFIG.MAX_TEXT_LENGTH} 字符`;
  }
  if (params.text.trim().length === 0) {
    return '文本不能为空';
  }
  if (params.speed !== undefined && (params.speed < 0.5 || params.speed > 2.0)) {
    return '语速必须在 0.5 - 2.0 之间';
  }
  if (params.volume !== undefined && (params.volume < 0.5 || params.volume > 2.0)) {
    return '音量必须在 0.5 - 2.0 之间';
  }
  if (params.voice && !AVAILABLE_VOICES.includes(params.voice as VoiceType)) {
    return `不支持的声音类型: ${params.voice}。可选: ${AVAILABLE_VOICES.join(', ')}`;
  }
  return null;
}

export async function executeTextToSpeech(
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

  const params = args as unknown as TextToSpeechParams;
  if (typeof params.text !== 'string') {
    return { ok: false, error: 'text is required and must be a string', code: 'INVALID_ARGS' };
  }

  const validationError = validateParams(params);
  if (validationError) {
    return { ok: false, error: validationError, code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();

  try {
    const configService = getConfigService();
    const zhipuApiKey = configService.getApiKey('zhipu');
    if (!zhipuApiKey) {
      return {
        ok: false,
        error: TOOL_DEPENDENCY_HINTS.textToSpeechZhipu,
        code: 'NOT_INITIALIZED',
      };
    }

    ctx.emit({
      type: 'tool_output',
      tool: 'text_to_speech',
      message: `🔊 正在合成语音 (${params.text.length} 字符)...`,
    } as never);

    const requestBody = {
      model: CONFIG.MODEL,
      input: params.text,
      voice: params.voice || CONFIG.DEFAULT_VOICE,
      speed: params.speed ?? CONFIG.DEFAULT_SPEED,
      volume: params.volume ?? CONFIG.DEFAULT_VOLUME,
      response_format: params.format || CONFIG.DEFAULT_FORMAT,
    };

    ctx.logger.debug('text_to_speech request', {
      textLength: params.text.length,
      voice: requestBody.voice,
      speed: requestBody.speed,
      format: requestBody.response_format,
    });

    const response = await fetchWithAbort(
      CONFIG.API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${zhipuApiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      CONFIG.TIMEOUT_MS,
      ctx.abortSignal,
    );

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`智谱 TTS API 错误: ${response.status} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioData = Buffer.from(arrayBuffer);

    const processingTime = Date.now() - startTime;
    const format = params.format || CONFIG.DEFAULT_FORMAT;

    let outputPath: string | undefined;
    let output: string;

    if (params.output_path) {
      outputPath = path.isAbsolute(params.output_path)
        ? params.output_path
        : path.join(ctx.workingDir, params.output_path);

      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!outputPath.endsWith(`.${format}`)) {
        outputPath = `${outputPath}.${format}`;
      }

      fs.writeFileSync(outputPath, audioData);
      output = `语音合成成功，已保存到: ${outputPath}`;
      ctx.logger.debug('text_to_speech file saved', { path: outputPath });
    } else {
      const base64Audio = audioData.toString('base64');
      output = `语音合成成功。\n音频数据 (base64, ${format}): ${base64Audio.substring(0, 100)}...`;
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    const mimeType = format === 'wav' ? 'audio/wav' : 'audio/pcm';
    const artifact = outputPath
      ? await createFileArtifact(outputPath, schema.name, ctx, {
          kind: 'audio',
          mimeType,
          metadata: {
            textLength: params.text.length,
            voice: params.voice || CONFIG.DEFAULT_VOICE,
            speed: params.speed ?? CONFIG.DEFAULT_SPEED,
            format,
            mediaKind: 'audio',
            model: CONFIG.MODEL,
          },
        })
      : createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'audio',
          sessionId: ctx.sessionId,
          name: `Speech audio (${format})`,
          mimeType,
          contentLength: audioData.length,
          metadata: {
            textLength: params.text.length,
            voice: params.voice || CONFIG.DEFAULT_VOICE,
            speed: params.speed ?? CONFIG.DEFAULT_SPEED,
            format,
            embeddedBase64: true,
            mediaKind: 'audio',
            model: CONFIG.MODEL,
          },
        });

    return {
      ok: true,
      output,
      meta: {
        artifact,
        outputPath,
        textLength: params.text.length,
        audioSizeBytes: audioData.length,
        voice: params.voice || CONFIG.DEFAULT_VOICE,
        speed: params.speed ?? CONFIG.DEFAULT_SPEED,
        format,
        mimeType,
        mediaKind: 'audio',
        contentLength: audioData.length,
        truncated: !outputPath,
        processingTimeMs: processingTime,
        model: CONFIG.MODEL,
      },
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('text_to_speech failed', { error: message });
    return { ok: false, error: `语音合成失败: ${message}` };
  }
}

class TextToSpeechHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTextToSpeech(args, ctx, canUseTool, onProgress);
  }
}

export const textToSpeechModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TextToSpeechHandler();
  },
};
