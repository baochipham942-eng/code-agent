// ============================================================================
// music_generate（音乐最后一公里 Spec1 · U2 — network/media: native ToolModule）
//
// agent 对话产物入口：把已就绪的 generateMusic 引擎 + resolveMusicModelEndpoint 共享端点解析
// 包成内置工具，agent 在"做音乐/配乐/写首歌/背景音乐"时调用，出片落 audio file artifact，
// 经 workbench 媒体组件渲染为可播放音乐（audio 已是受支持的 artifact 类型）。
//
// N-MEDIA-GEN-PHASE2 对齐 image 合同（N-MEDIA-GEN-CONTRACT）：
// - output_path → output_file_path（工作区相对，边界检查沿用 workspaceScope 守卫）
// - 输出首行「N/1 saved」+ per_request JSON；MiniMax 非零 base_resp 如实进 error 且不重试
// - N-MEDIA-GEN-MUSIC-FALLBACK：内置默认模型撞 HTTP 410 / 缺 MiniMax key 时返回
//   MUSIC_SERVICE_UNAVAILABLE(_NO_ALTERNATIVE) 结构化出路（桥接音乐模型列表或告知用户），不重试
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
import type { AppSettings } from '../../../../shared/contract';
import { getConfigService } from '../../../services';
import { getMinimaxApiKey } from '../../../services/media/imageGenerationService';
import { createFileArtifact } from '../../../tools/artifacts/artifactMeta';
import { generateMusic, resolveMusicModelEndpoint, MusicHttpError } from '../../../services/media/musicGenerationService';
import { deriveBridgedVisualModels } from '../../../../shared/visualModelBridge';
import { estimateMusicCostCny } from '../../../../shared/media/musicCost';
import { isPathWithinRoot, resolveWorkspacePath } from '../../../runtime/workspaceScope';
import { musicGenerateSchema as schema } from './musicGenerate.schema';

const DEFAULT_MUSIC_MODEL = 'minimax-music-2.6';
const DEFAULT_MUSIC_ARTIFACT_DIR = path.join('.code-agent', 'artifacts', 'music');

interface PerRequest {
  index: number;
  status: 'saved' | 'failed';
  bytes?: number;
  path?: string;
  error?: string;
}

function defaultMusicOutputPath(workingDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  return path.join(workingDir, DEFAULT_MUSIC_ARTIFACT_DIR, `generated-${timestamp}.mp3`);
}

function outputPathOutsideWorkspace(resolved: string, ctx: ToolContext): boolean {
  if (isPathWithinRoot(resolved, ctx.workingDir)) return false;
  if (!ctx.workspaceScope) return true;
  return resolveWorkspacePath(ctx.workspaceScope, resolved, 'read_write') === undefined;
}

function workspaceRelativePath(absolutePath: string, ctx: ToolContext): string {
  if (ctx.workspaceScope) {
    const match = resolveWorkspacePath(ctx.workspaceScope, absolutePath, 'read');
    if (match) return match.relativePath || path.basename(absolutePath);
  }
  return path.relative(ctx.workingDir, absolutePath) || path.basename(absolutePath);
}

/** 已配置的桥接音乐模型 id（provider:model）——内置 MiniMax 不可用时的出路列表。 */
function bridgedMusicModelIds(settings: AppSettings | null): string[] {
  return deriveBridgedVisualModels(settings)
    .filter((entry) => entry.mediaType === 'music')
    .map((entry) => entry.id);
}

/**
 * 内置默认 MiniMax 音乐服务不可用（HTTP 410 关停 / 缺 key）的结构化出路（N-MEDIA-GEN-MUSIC-FALLBACK）：
 * 付费音乐 API 2026-08-20 起对新账户关闭，死胡同报错换成可执行动作——不重试；
 * 有桥接音乐模型时列出可换的 model id，没有则明说当前不可用、让模型转告用户。
 */
function musicServiceUnavailableResult(
  reason: 'HTTP 410' | 'no key',
  perRequestError: string,
  alternatives: string[],
): ToolResult<string> {
  const perRequest: PerRequest[] = [{ index: 1, status: 'failed', error: perRequestError }];
  const summary = `0/1 saved\nper_request ${JSON.stringify(perRequest)}`;
  const head = `The default MiniMax music service is unavailable (${reason}). Do not retry.`;
  if (alternatives.length > 0) {
    return {
      ok: false,
      error: `${summary}\n${head} Configured music models you can pass as \`model\`: ${alternatives.join(', ')}.`,
      code: 'MUSIC_SERVICE_UNAVAILABLE',
      meta: { artifacts: [], per_request: perRequest, alternatives: alternatives.join(', ') },
    };
  }
  return {
    ok: false,
    error: `${summary}\n${head} No other music model is configured; tell the user music generation is currently unavailable.`,
    code: 'MUSIC_SERVICE_UNAVAILABLE_NO_ALTERNATIVE',
    meta: { artifacts: [], per_request: perRequest },
  };
}

/**
 * 参数校验（全部先于任何付费调用 / 进度事件 / 写盘）：旧 output_path 改名提示、
 * output_file_path 越界。内置默认模型缺 MiniMax key 不在这里拦——由 executeMusicGenerate
 * 的服务不可用出路口处理（getMinimaxApiKey 是唯一 key 通路）。
 */
function validateMusicGenerateArgs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { ok: true; params: { prompt: string; lyrics?: string; model: string; outputFilePath: string } }
  | { ok: false; error: string; meta?: Record<string, unknown> } {
  if (Object.prototype.hasOwnProperty.call(args, 'output_path')) {
    return { ok: false, error: 'output_path was renamed to output_file_path; use output_file_path' };
  }

  const prompt = args.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { ok: false, error: 'prompt is required and must be a string' };
  }

  const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : DEFAULT_MUSIC_MODEL;

  const rawOutputFilePath = args.output_file_path;
  if (rawOutputFilePath !== undefined && typeof rawOutputFilePath !== 'string') {
    return { ok: false, error: 'output_file_path must be a workspace path' };
  }
  if (typeof rawOutputFilePath === 'string' && rawOutputFilePath.length > 0) {
    const resolvedOutputPath = path.resolve(ctx.workingDir, rawOutputFilePath);
    if (outputPathOutsideWorkspace(resolvedOutputPath, ctx)) {
      return {
        ok: false,
        error: `output_file_path "${resolvedOutputPath}" must be inside the workspace`,
        meta: { outputPath: resolvedOutputPath },
      };
    }
    return { ok: true, params: { prompt, lyrics: typeof args.lyrics === 'string' ? args.lyrics : undefined, model, outputFilePath: resolvedOutputPath } };
  }

  return {
    ok: true,
    params: { prompt, lyrics: typeof args.lyrics === 'string' ? args.lyrics : undefined, model, outputFilePath: defaultMusicOutputPath(ctx.workingDir) },
  };
}

export async function executeMusicGenerate(
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

  const validation = validateMusicGenerateArgs(args, ctx);
  if (!validation.ok) {
    return { ok: false, error: validation.error, code: 'INVALID_ARGS', meta: validation.meta };
  }
  const params = validation.params;
  const outputPath = params.outputFilePath;

  // 服务不可用出路口（N-MEDIA-GEN-MUSIC-FALLBACK）：内置默认模型 + 缺 MiniMax key
  // （getMinimaxApiKey 唯一 key 通路）在付费前返回结构化出路，先于任何进度事件 / 写盘。
  if (!params.model.includes(':') && !getMinimaxApiKey()) {
    return musicServiceUnavailableResult('no key', 'MiniMax API key is missing', bridgedMusicModelIds(getConfigService().getSettings()));
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const startTime = Date.now();

  try {
    if (ctx.currentToolCallId) {
      ctx.emit({
        type: 'artifact_write_started',
        data: {
          toolCallId: ctx.currentToolCallId,
          toolName: schema.name,
          filePath: outputPath,
        },
      });
    }

    // 端点解析前置（付费守门）：桥接模型未知 id / 缺 key 在此抛错，generateMusic 不被调用。
    const { baseUrl, apiKey, modelName } = resolveMusicModelEndpoint(
      params.model,
      getConfigService().getSettings(),
    );

    ctx.emit({
      type: 'tool_output',
      tool: schema.name,
      message: '🎵 正在生成音乐（可能需要 30-120 秒）...',
    } as never);

    const { audioBuffer, actualModel } = await generateMusic({
      baseUrl,
      apiKey,
      modelName,
      prompt: params.prompt,
      lyrics: params.lyrics,
      outerSignal: ctx.abortSignal,
    });

    // 生成返回后、写盘前再查一次中止：用户已停止的请求不再落盘（对齐 image 合同返修）。
    if (ctx.abortSignal.aborted) throw new Error('aborted');

    try {
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, audioBuffer);
    } catch (error: unknown) {
      if (ctx.abortSignal.aborted) throw error;
      ctx.logger.warn('music_generate save failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('music was generated but could not be saved', { cause: error });
    }

    const generationTime = Date.now() - startTime;
    const costCny = estimateMusicCostCny(actualModel);

    const artifact = await createFileArtifact(outputPath, schema.name, ctx, {
      kind: 'audio',
      mimeType: 'audio/mpeg',
      sizeBytes: audioBuffer.length,
      metadata: {
        model: actualModel,
        prompt: params.prompt,
        lyrics: params.lyrics,
        costCny,
        generationTimeMs: generationTime,
        mediaKind: 'audio',
      },
    });

    const perRequest: PerRequest[] = [{
      index: 1,
      status: 'saved',
      bytes: audioBuffer.length,
      path: workspaceRelativePath(outputPath, ctx),
    }];
    const output = `1/1 saved\nper_request ${JSON.stringify(perRequest)}`;

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
        artifact,
        artifacts: [artifact],
        per_request: perRequest,
        model: actualModel,
        prompt: params.prompt,
        outputPath,
        audioPath: outputPath,
        costCny,
        mediaKind: 'audio',
        generationTimeMs: generationTime,
      },
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'aborted') {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    // 内置默认模型撞 MiniMax 付费音乐 API 关停（HTTP 410，2026-08-20 起对新账户关闭）：
    // 终态不可重试，走结构化出路（桥接音乐模型列表 / 告知用户），不进通用失败。
    if (error instanceof MusicHttpError && error.status === 410 && !params.model.includes(':')) {
      ctx.logger.warn('music_generate default service unavailable (HTTP 410)', { error: message });
      return musicServiceUnavailableResult('HTTP 410', message, bridgedMusicModelIds(getConfigService().getSettings()));
    }
    ctx.logger.warn('music_generate failed', { error: message });
    const perRequest: PerRequest[] = [{ index: 1, status: 'failed', error: message }];
    const summary = `0/1 saved\nper_request ${JSON.stringify(perRequest)}`;
    return {
      ok: false,
      error: summary,
      code: 'MUSIC_GENERATION_FAILED',
      meta: { artifacts: [], per_request: perRequest },
    };
  }
}

class MusicGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeMusicGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const musicGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new MusicGenerateHandler();
  },
};
