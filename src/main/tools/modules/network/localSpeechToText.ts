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

import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { localSpeechToTextSchema as schema } from './localSpeechToText.schema';
import {
  LocalSpeechTranscriptionError,
  LOCAL_SPEECH_CONFIG,
  transcribeWithWhisperCpp,
} from '../../../services/speech/whisperCppTranscriber';

interface LocalSpeechToTextParams {
  file_path: string;
  language?: string;
  model?: string;
  threads?: number;
  output_format?: 'text' | 'srt' | 'vtt';
  translate?: boolean;
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
    const transcript = await transcribeWithWhisperCpp({
      filePath: params.file_path,
      workingDir: ctx.workingDir,
      language: params.language,
      model: params.model,
      threads: params.threads,
      outputFormat: params.output_format,
      translate: params.translate,
      signal: ctx.abortSignal,
      logger: ctx.logger,
      onStart: ({ model, language }) => {
        ctx.emit({
          type: 'tool_output',
          tool: 'local_speech_to_text',
          message: `正在转写语音 (模型: ${model}, 语言: ${language})...`,
        } as never);
      },
      onConvert: ({ extension }) => {
        ctx.emit({
          type: 'tool_output',
          tool: 'local_speech_to_text',
          message: `正在转换 ${extension} → WAV...`,
        } as never);
      },
    });

      onProgress?.({ stage: 'completing', percent: 100 });

      return {
        ok: true,
        output: transcript.text,
        meta: {
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `Local transcript: ${path.basename(transcript.sourcePath)}`,
            mimeType: transcript.outputFormat === 'text' ? 'text/plain' : 'text/vtt',
            contentLength: transcript.text.length,
            preview: transcript.text.slice(0, 500),
            metadata: {
              sourcePath: transcript.sourcePath,
              model: transcript.model,
              language: transcript.language,
              outputFormat: transcript.outputFormat,
              translate: params.translate === true,
              mediaKind: 'audio',
              artifactRole: 'transcript',
            },
          }),
          filePath: transcript.sourcePath,
          sourcePath: transcript.sourcePath,
          mediaKind: 'audio',
          model: transcript.model,
          language: transcript.language,
          outputFormat: transcript.outputFormat,
          textLength: transcript.text.length,
          contentLength: transcript.text.length,
          truncated: false,
          processingTimeMs: transcript.processingTimeMs || Date.now() - startTime,
        },
      };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    if (error instanceof LocalSpeechTranscriptionError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
      };
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('local_speech_to_text failed', { error: errMsg });
    const errMeta = error as Record<string, unknown>;
    if (errMeta.killed || errMeta.signal === 'SIGTERM') {
      return {
        ok: false,
        error: `转写超时（超过 ${LOCAL_SPEECH_CONFIG.TIMEOUT_MS / 1000} 秒）。可尝试：\n- 使用更小的模型（如 base 或 small）\n- 增加线程数\n- 分割长音频`,
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
