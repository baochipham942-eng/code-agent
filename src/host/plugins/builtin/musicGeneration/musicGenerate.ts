// ============================================================================
// music_generate（音乐最后一公里 Spec1 · U2 — network/media: native ToolModule）
//
// agent 对话产物入口：把已就绪的 generateMusic 引擎 + resolveMusicModelEndpoint 共享端点解析
// 包成内置工具，agent 在"做音乐/配乐/写首歌/背景音乐"时调用，出片落 audio file artifact，
// 经 workbench 媒体组件渲染为可播放音乐（audio 已是受支持的 artifact 类型）。
//
// 镜像 videoGenerate.ts 的 ToolModule 形状：executeMusicGenerate（纯函数，可测）
// + MusicGenerateHandler（ToolHandler）+ musicGenerateModule（ToolModule）。
// 端点解析（内置 MiniMax / 桥接 provider:model / 未知 id / 缺 key）全部前置于付费 generateMusic
// 调用：解析抛错 → 返回 error result，generateMusic 零调用，杜绝 paid no-op。
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
import { createFileArtifact } from '../../../tools/artifacts/artifactMeta';
import { generateMusic, resolveMusicModelEndpoint } from '../../../services/media/musicGenerationService';
import { estimateMusicCostCny } from '../../../../shared/media/musicCost';
import { musicGenerateSchema as schema } from './musicGenerate.schema';

const DEFAULT_MUSIC_MODEL = 'minimax-music-2.6';
const DEFAULT_MUSIC_ARTIFACT_DIR = path.join('.code-agent', 'artifacts', 'music');

interface MusicGenerateParams {
  prompt: string;
  lyrics?: string;
  model?: string;
  output_path?: string;
}

function defaultMusicOutputPath(workingDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  return path.join(workingDir, DEFAULT_MUSIC_ARTIFACT_DIR, `generated-${timestamp}.mp3`);
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

  onProgress?.({ stage: 'starting', detail: schema.name });

  const params = args as unknown as MusicGenerateParams;
  if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
    return { ok: false, error: 'prompt is required and must be a string', code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();
  const outputPath = params.output_path || defaultMusicOutputPath(ctx.workingDir);

  try {
    // 端点解析前置（付费守门）：未知 id / 缺 key 在此抛错，generateMusic 不被调用，不出片不付费。
    const { baseUrl, apiKey, modelName } = resolveMusicModelEndpoint(
      params.model || DEFAULT_MUSIC_MODEL,
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

    const resolvedPath = path.isAbsolute(outputPath)
      ? outputPath
      : path.join(ctx.workingDir, outputPath);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, audioBuffer);

    const generationTime = Date.now() - startTime;
    const costCny = estimateMusicCostCny(actualModel);

    const artifact = await createFileArtifact(resolvedPath, schema.name, ctx, {
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

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output: `音乐生成成功，已保存到: ${resolvedPath}`,
      meta: {
        artifact,
        model: actualModel,
        prompt: params.prompt,
        outputPath: resolvedPath,
        audioPath: resolvedPath,
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
    ctx.logger.warn('music_generate failed', { error: message });
    return { ok: false, error: `音乐生成失败: ${message}` };
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
