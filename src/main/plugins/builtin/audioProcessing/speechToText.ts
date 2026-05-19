// ============================================================================
// speech_to_text (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy SpeechToTextTool 迁移到 native：智谱 GLM-ASR-2512 调用、文件验证、
// base64 编码 JSON 请求都直接落到 module 里。abort 走 race-and-abandon
// 把 fetch AbortController 与 ctx.abortSignal 联动，参考 lsp.ts。
//
// 行为保真：legacy emit('tool_output')/中文文案/metadata 形状 1:1 复刻。
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
import { createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { MODEL_API_ENDPOINTS } from '../../../../shared/constants';
import { speechToTextSchema as schema } from './speechToText.schema';

const CONFIG = {
  API_URL: `${MODEL_API_ENDPOINTS.zhipuOfficial}/audio/transcriptions`,
  MODEL: 'glm-asr-2512',
  TIMEOUT_MS: 60000,
  MAX_FILE_SIZE_MB: 25,
  MAX_DURATION_SECONDS: 30,
  SUPPORTED_FORMATS: ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm'],
};

interface SpeechToTextParams {
  file_path: string;
  hotwords?: string;
  prompt?: string;
}

interface ZhipuASRResponse {
  id?: string;
  text?: string;
  error?: { code: string; message: string };
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
  };
  return map[ext] || 'audio/wav';
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

export async function executeSpeechToText(
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

  const params = args as unknown as SpeechToTextParams;
  if (typeof params.file_path !== 'string' || params.file_path.length === 0) {
    return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();

  try {
    const configService = getConfigService();
    const zhipuApiKey = configService.getApiKey('zhipu');

    if (!zhipuApiKey) {
      return {
        ok: false,
        error: '语音转文字需要配置智谱 API Key。请在设置中添加智谱 API Key。',
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

    const stats = fs.statSync(filePath);

    const ext = path.extname(filePath).toLowerCase();
    if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
      return {
        ok: false,
        error: `不支持的音频格式: ${ext}。支持的格式: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
        code: 'INVALID_ARGS',
      };
    }

    const sizeMB = stats.size / (1024 * 1024);
    if (sizeMB > CONFIG.MAX_FILE_SIZE_MB) {
      return {
        ok: false,
        error: `文件过大: ${sizeMB.toFixed(2)} MB。最大支持 ${CONFIG.MAX_FILE_SIZE_MB} MB`,
        code: 'INVALID_ARGS',
      };
    }

    const fileSizeMB = sizeMB.toFixed(2);

    ctx.emit({
      type: 'tool_output',
      tool: 'speech_to_text',
      message: `🎤 正在识别语音 (${fileSizeMB} MB)...`,
    } as never);

    const audioData = fs.readFileSync(filePath);
    const base64Audio = audioData.toString('base64');
    const mimeType = getMimeType(filePath);

    const jsonBody = {
      model: CONFIG.MODEL,
      file: `data:${mimeType};base64,${base64Audio}`,
      stream: false,
      ...(params.hotwords && { hotwords: params.hotwords }),
      ...(params.prompt && { prompt: params.prompt }),
    };

    ctx.logger.debug('speech_to_text request', {
      fileName: path.basename(filePath),
      fileSize: audioData.length,
      hasHotwords: !!params.hotwords,
      hasPrompt: !!params.prompt,
    });

    const response = await fetchWithAbort(
      CONFIG.API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${zhipuApiKey}`,
        },
        body: JSON.stringify(jsonBody),
      },
      CONFIG.TIMEOUT_MS,
      ctx.abortSignal,
    );

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

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

    const processingTime = Date.now() - startTime;

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('speech_to_text done', {
      textLength: result.text.length,
      processingTimeMs: processingTime,
    });

    return {
      ok: true,
      output: result.text,
      meta: {
        artifact: createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'text',
          sessionId: ctx.sessionId,
          name: `Transcript: ${path.basename(filePath)}`,
          mimeType: 'text/plain',
          contentLength: result.text.length,
          preview: result.text.slice(0, 500),
          metadata: {
            sourcePath: filePath,
            sourceMimeType: mimeType,
            sourceSizeBytes: stats.size,
            mediaKind: 'audio',
            model: CONFIG.MODEL,
            artifactRole: 'transcript',
          },
        }),
        filePath,
        sourcePath: filePath,
        mediaKind: 'audio',
        mimeType,
        sourceSizeBytes: stats.size,
        fileSizeMB: parseFloat(fileSizeMB),
        textLength: result.text.length,
        contentLength: result.text.length,
        truncated: false,
        processingTimeMs: processingTime,
        model: CONFIG.MODEL,
      },
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('speech_to_text failed', { error: message });
    return { ok: false, error: `语音转文字失败: ${message}` };
  }
}

class SpeechToTextHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeSpeechToText(args, ctx, canUseTool, onProgress);
  }
}

export const speechToTextModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SpeechToTextHandler();
  },
};
