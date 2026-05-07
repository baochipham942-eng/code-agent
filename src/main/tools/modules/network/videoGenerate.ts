// ============================================================================
// video_generate (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy VideoGenerateTool 迁移到 native：智谱 CogVideoX 异步任务（提交
// → 轮询 → 下载）+ GLM 文生/图生 prompt 双策略扩写。
//
// abort signal 走 race-and-abandon：fetch + 轮询 sleep 都监听 outerSignal，
// abort 后立即停止轮询并返回 ABORTED。
//
// 行为保真：legacy 中文文案、emoji（🎬 ✨ 📝 ⏳ 📥）、CogVideoX 提示词模板
// （TEXT_TO_VIDEO_PROMPT / IMAGE_TO_VIDEO_PROMPT）、5 种 aspect ratio →
// 官方 size 映射、metadata 形状 1:1 复刻。
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
import { DEFAULT_MODELS } from '../../../../shared/constants';
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { videoGenerateSchema as schema } from './videoGenerate.schema';

const TIMEOUT_MS = {
  SUBMIT: 30000,
  POLL: 5000,
  MAX_WAIT: 300000,
};

const ZHIPU_VIDEO_MODELS = {
  standard: 'cogvideox-2',
  legacy: 'cogvideox-flash',
} as const;

const VIDEO_SIZES = {
  '16:9': '1920x1080',
  '9:16': '1080x1920',
  '1:1': '1024x1024',
  '4:3': '1280x960',
  '3:4': '960x1280',
} as const;

interface VideoGenerateParams {
  prompt: string;
  image_url?: string;
  aspect_ratio?: '16:9' | '9:16' | '1:1';
  quality?: 'quality' | 'speed';
  duration?: 5 | 10;
  fps?: 30 | 60;
  output_path?: string;
}

interface ZhipuVideoTaskResponse {
  id: string;
  model: string;
  task_status: 'PROCESSING' | 'SUCCESS' | 'FAIL';
  video_result?: Array<{ url: string; cover_image_url: string }>;
  error?: { code: string; message: string };
}

function getZhipuOfficialApiKey(): string | undefined {
  const officialKey = process.env.ZHIPU_OFFICIAL_API_KEY;
  if (officialKey) return officialKey;
  const configService = getConfigService();
  const zhipuKey = configService.getApiKey('zhipu');
  if (zhipuKey && !zhipuKey.startsWith('oki-')) return zhipuKey;
  return undefined;
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

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort);
  });
}

const TEXT_TO_VIDEO_PROMPT = `你是专业的 AI 视频提示词工程师。将用户的简短描述扩展为高质量的 CogVideoX 视频生成提示词。

## 提示词结构公式

主体(含外观) + 动作(含强度) + 场景(含光影) + 镜头(含运动) + 风格

## 核心规则

1. **动作优先**：视频的核心是运动和变化，减少静态描述，聚焦动作
2. **程度副词必须明确**："快速奔跑"而非"跑"，"猛烈挥拳"而非"打"，"缓慢转身"而非"转"
3. **镜头语言明确**：使用专业术语 — 推(zoom in)/拉(zoom out)/摇(pan)/移(dolly)/跟(tracking)/环绕(orbit)/升降(crane)/一镜到底(long take)
4. **光影氛围具体**：逆光/侧光/体积光/丁达尔效应/黄金时刻/霓虹灯光
5. **每次聚焦**：1 个主体 + 1 个主动作 + 1 个镜头运动
6. **正面描述**：CogVideoX 不支持否定提示词，用正面描述替代（"清晰画面"而非"没有模糊"）
7. **控制在 200 字以内**
8. **直接输出优化后的提示词，不要解释**`;

const IMAGE_TO_VIDEO_PROMPT = `你是专业的 AI 视频提示词工程师。用户提供了一张起始图片，你需要描述图片中的内容应该如何动起来。

## 核心原则（图生视频专用）

1. **不要重复描述图片中已有的静态内容**（模型已经能看到图片）
2. **聚焦三个方面**：主体要做什么动作 + 镜头怎么移动 + 背景怎么变化
3. **添加区分性特征**帮助模型定位主体（如"戴墨镜的女人"、"红色跑车"）
4. **程度副词明确运动强度**："猛烈"、"轻柔"、"缓慢"、"快速"
5. **正面描述**：CogVideoX 不支持否定提示词
6. **控制在 150 字以内**（图片已包含视觉信息，提示词更精简）
7. **直接输出优化后的提示词，不要解释**`;

async function expandVideoPrompt(
  apiKey: string,
  shortPrompt: string,
  outerSignal: AbortSignal,
  logger: ToolContext['logger'],
  imageUrl?: string,
): Promise<string> {
  const systemPrompt = imageUrl ? IMAGE_TO_VIDEO_PROMPT : TEXT_TO_VIDEO_PROMPT;

  try {
    const response = await fetchWithAbort(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODELS.quick,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: shortPrompt },
          ],
          max_tokens: 800,
        }),
      },
      15000,
      outerSignal,
    );

    if (!response.ok) {
      logger.warn('video_generate prompt expand non-ok');
      return shortPrompt;
    }

    const result = await response.json();
    const msg = result.choices?.[0]?.message;
    const expandedPrompt = (msg?.content || msg?.reasoning_content || '').trim();
    if (expandedPrompt) {
      return expandedPrompt;
    }
    return shortPrompt;
  } catch (error) {
    logger.warn('video_generate prompt expand failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return shortPrompt;
  }
}

async function submitZhipuVideoTask(
  apiKey: string,
  params: {
    prompt: string;
    imageUrl?: string;
    size: string;
    quality: string;
    duration: number;
    fps: number;
  },
  outerSignal: AbortSignal,
): Promise<string> {
  const requestBody: Record<string, unknown> = {
    model: ZHIPU_VIDEO_MODELS.standard,
    prompt: params.prompt,
    quality: params.quality,
    size: params.size,
    duration: params.duration,
    fps: params.fps,
  };
  if (params.imageUrl) {
    requestBody.image_url = params.imageUrl;
  }

  const response = await fetchWithAbort(
    'https://open.bigmodel.cn/api/paas/v4/videos/generations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    TIMEOUT_MS.SUBMIT,
    outerSignal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱视频生成 API 错误: ${response.status} - ${error}`);
  }

  const result = await response.json();
  if (!result.id) {
    throw new Error('智谱视频生成: 未返回任务 ID');
  }
  return result.id;
}

async function queryZhipuVideoTask(
  apiKey: string,
  taskId: string,
  outerSignal: AbortSignal,
): Promise<ZhipuVideoTaskResponse> {
  const response = await fetchWithAbort(
    `https://open.bigmodel.cn/api/paas/v4/async-result/${taskId}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    TIMEOUT_MS.SUBMIT,
    outerSignal,
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`查询任务状态失败: ${response.status} - ${error}`);
  }
  return response.json();
}

async function waitForZhipuVideoCompletion(
  apiKey: string,
  taskId: string,
  outerSignal: AbortSignal,
  emit: (msg: string) => void,
): Promise<{ videoUrl: string; coverUrl: string }> {
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS.MAX_WAIT) {
    if (outerSignal.aborted) throw new Error('aborted');

    const result = await queryZhipuVideoTask(apiKey, taskId, outerSignal);

    if (result.task_status === 'SUCCESS') {
      if (!result.video_result || result.video_result.length === 0) {
        throw new Error('视频生成成功但未返回视频 URL');
      }
      return {
        videoUrl: result.video_result[0].url,
        coverUrl: result.video_result[0].cover_image_url,
      };
    }

    if (result.task_status === 'FAIL') {
      throw new Error(
        `视频生成失败: ${result.error?.message || '未知错误'} (${result.error?.code || 'UNKNOWN'})`,
      );
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    emit(`⏳ 视频生成中... (${elapsed}秒)`);

    await sleepWithAbort(TIMEOUT_MS.POLL, outerSignal);
  }

  throw new Error(`视频生成超时（${TIMEOUT_MS.MAX_WAIT / 1000}秒）`);
}

async function downloadVideo(
  url: string,
  outputPath: string,
  outerSignal: AbortSignal,
): Promise<void> {
  const response = await fetchWithAbort(url, {}, 60000, outerSignal);
  if (!response.ok) {
    throw new Error(`下载视频失败: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

export async function executeVideoGenerate(
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

  const params = args as unknown as VideoGenerateParams;
  if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
    return { ok: false, error: 'prompt is required and must be a string', code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();

  try {
    const zhipuApiKey = getZhipuOfficialApiKey();
    if (!zhipuApiKey) {
      return {
        ok: false,
        error: '视频生成需要配置智谱官方 API Key (ZHIPU_OFFICIAL_API_KEY)。0ki 代理不支持视频生成。',
        code: 'NOT_INITIALIZED',
      };
    }

    ctx.emit({
      type: 'tool_output',
      tool: 'video_generate',
      message: '🎬 正在生成视频（可能需要 30-180 秒）...',
    } as never);

    const aspectRatio = params.aspect_ratio || '16:9';
    const size = VIDEO_SIZES[aspectRatio as keyof typeof VIDEO_SIZES] || VIDEO_SIZES['16:9'];

    ctx.emit({
      type: 'tool_output',
      tool: 'video_generate',
      message: '✨ 优化视频描述...',
    } as never);

    const expandedPrompt = await expandVideoPrompt(
      zhipuApiKey,
      params.prompt,
      ctx.abortSignal,
      ctx.logger,
      params.image_url,
    );

    const taskId = await submitZhipuVideoTask(
      zhipuApiKey,
      {
        prompt: expandedPrompt,
        imageUrl: params.image_url,
        size,
        quality: params.quality || 'quality',
        duration: params.duration || 5,
        fps: params.fps || 30,
      },
      ctx.abortSignal,
    );

    ctx.emit({
      type: 'tool_output',
      tool: 'video_generate',
      message: `📝 任务已提交，ID: ${taskId.slice(0, 8)}...`,
    } as never);

    const taskResult = await waitForZhipuVideoCompletion(
      zhipuApiKey,
      taskId,
      ctx.abortSignal,
      (message) => {
        ctx.emit({ type: 'tool_output', tool: 'video_generate', message } as never);
      },
    );

    const generationTime = Date.now() - startTime;

    let videoPath: string | undefined;
    if (params.output_path) {
      const resolvedPath = path.isAbsolute(params.output_path)
        ? params.output_path
        : path.join(ctx.workingDir, params.output_path);

      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      ctx.emit({
        type: 'tool_output',
        tool: 'video_generate',
        message: '📥 正在下载视频...',
      } as never);

      await downloadVideo(taskResult.videoUrl, resolvedPath, ctx.abortSignal);
      videoPath = resolvedPath;
    }

    onProgress?.({ stage: 'completing', percent: 100 });

    const output = videoPath
      ? `视频生成成功，已保存到: ${videoPath}`
      : `视频生成成功。\n视频 URL: ${taskResult.videoUrl}\n封面 URL: ${taskResult.coverUrl}`;
    const artifact = videoPath
      ? await createFileArtifact(videoPath, schema.name, ctx, {
          kind: 'video',
          mimeType: 'video/mp4',
          metadata: {
            prompt: params.prompt,
            expandedPrompt,
            taskId,
            coverUrl: taskResult.coverUrl,
            aspectRatio: params.aspect_ratio || '16:9',
            duration: params.duration || 5,
            fps: params.fps || 30,
            mediaKind: 'video',
          },
        })
      : createVirtualArtifact({
          sourceTool: schema.name,
          kind: 'video',
          sessionId: ctx.sessionId,
          name: `Generated video: ${params.prompt.slice(0, 80)}`,
          url: taskResult.videoUrl,
          mimeType: 'video/mp4',
          contentLength: output.length,
          preview: output.slice(0, 500),
          metadata: {
            prompt: params.prompt,
            expandedPrompt,
            taskId,
            coverUrl: taskResult.coverUrl,
            aspectRatio: params.aspect_ratio || '16:9',
            duration: params.duration || 5,
            fps: params.fps || 30,
            mediaKind: 'video',
          },
        });

    return {
      ok: true,
      output,
      meta: {
        artifact,
        videoUrl: taskResult.videoUrl,
        coverUrl: taskResult.coverUrl,
        videoPath,
        outputPath: videoPath,
        prompt: params.prompt,
        expandedPrompt,
        taskId,
        aspectRatio: params.aspect_ratio || '16:9',
        duration: params.duration || 5,
        fps: params.fps || 30,
        mediaKind: 'video',
        contentLength: output.length,
        truncated: false,
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
    ctx.logger.warn('video_generate failed', { error: message });
    return { ok: false, error: `视频生成失败: ${message}` };
  }
}

class VideoGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeVideoGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const videoGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new VideoGenerateHandler();
  },
};
