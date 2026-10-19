// ============================================================================
// video_generate (P1 Wave 4 D2c — network/media: native ToolModule)
//
// N-MEDIA-GEN-PHASE2 对齐 image 合同（N-MEDIA-GEN-CONTRACT）：
// - output_path → output_file_path（工作区相对，边界检查沿用同一处 workspaceScope 守卫）
// - 默认走 MiniMax 海螺（generateVideo：t2v=MiniMax-Hailuo-02 / image_path→i2v=I2V-01）
// - cogvideox-* 仍走智谱旧路径（提交→轮询→下载），但现在一律落盘，不再返回 URL
// - 输出首行「N/1 saved」+ per_request JSON；output 与 meta 不出现远端 URL
//   （下载失败时 URL 只进虚拟产物 metadata，同 image 合同）
//
// abort signal 走 race-and-abandon：fetch + 轮询 sleep 都监听 outerSignal，
// abort 后立即停止轮询并返回 ABORTED；生成返回后、写盘前再查一次中止。
//
// N-MEDIA-GEN-VIDEO-IDEMPOTENT：校验通过后、任何进度事件和付费调用之前，按
// imageGenerateReuse 的同一本账、同一套 (a)(b)(c) 规则查可复用产物。崩溃重放或
// 未送达的同参数重试直接复用已落盘文件，不再向 MiniMax / CogVideoX 二次计费。
// ============================================================================

import { createHash } from 'crypto';
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
import { getZhipuOfficialVideoApiKey } from '../../../tools/modules/network/toolAvailability';
import { getMinimaxApiKey } from '../../../services/media/imageGenerationService';
import { downloadVideoAsBuffer, generateVideo } from '../../../services/media/videoGenerationService';
import { MODEL_API_ENDPOINTS, ZHIPU_OFFICIAL_QUICK_MODEL } from '../../../../shared/constants';
import {
  GENERATION_TOOL_DEFAULT_MODELS,
  GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC,
} from '../../../../shared/media/generationToolDefaults';
import { createFileArtifact, createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { isPathWithinRoot, resolveWorkspacePath } from '../../../runtime/workspaceScope';
import {
  lookupReusableGenerationOutputs,
  recordGenerationSavedOutput,
  REUSED_RESULT_LINE,
  sha256File,
  type GenerationLedgerSavedOutput,
} from '../imageCreation/imageGenerateReuse';
import { videoGenerateSchema as schema } from './videoGenerate.schema';
import { TOOL_DEPENDENCY_HINTS } from '../../../tools/modules/_helpers/dependencyHints';
import {
  isJsonRecord,
  readArrayField,
  readChatCompletionText,
  readRecordField,
  readStringField,
} from '../typedResponseGuards';
import { parseChatCompletionHttpBody } from '../../../model/parseSseChatCompletion';
import type { ToolArtifact } from '../../../../shared/contract/artifactBlob';

const TIMEOUT_MS = {
  SUBMIT: 30000,
  POLL: 5000,
  MAX_WAIT: 300000,
};

const ZHIPU_VIDEO_MODELS = {
  standard: 'cogvideox-2',
  legacy: 'cogvideox-flash',
} as const;

/** MiniMax 海螺图生视频模型（visualModels 注册表 id；默认文生视频模型在 shared/media/generationToolDefaults）。 */
const MINIMAX_I2V_MODEL = 'I2V-01';

const IMAGE_INPUT_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const IMAGE_INPUT_MAX_BYTES = 10 * 1024 * 1024;

const DEFAULT_VIDEO_ARTIFACT_DIR = path.join('.code-agent', 'artifacts', 'videos');

const VIDEO_SIZES = {
  '16:9': '1920x1080',
  '9:16': '1080x1920',
  '1:1': '1024x1024',
  '4:3': '1280x960',
  '3:4': '960x1280',
} as const;

interface VideoGenerateParams {
  prompt: string;
  zhipuRoute: boolean;
  model: string;
  imageDataUrl?: string;
  /** 调用方传入的 image_path 解析后的绝对路径。只进复用指纹。 */
  resolvedImagePath?: string;
  imageUrl?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  quality?: 'quality' | 'speed';
  duration?: 5 | 10;
  fps?: 30 | 60;
  outputFilePath: string;
  /** 调用方传入的 output_file_path 解析后的绝对路径。未传时不进指纹。 */
  explicitOutputFilePath?: string;
}

interface PerRequest {
  index: number;
  status: 'saved' | 'failed';
  bytes?: number;
  path?: string;
  error?: string;
  reused?: boolean;
}

/** 下载/落盘失败：携带虚拟产物（远端 URL 只进产物 metadata，不进 output/meta 其它位置）。 */
class VideoSaveFailure extends Error {
  readonly artifact?: ToolArtifact;

  constructor(message: string, artifact?: ToolArtifact) {
    super(message);
    this.name = 'VideoSaveFailure';
    this.artifact = artifact;
  }
}

interface ZhipuVideoTaskResponse {
  id?: string;
  model?: string;
  task_status: 'PROCESSING' | 'SUCCESS' | 'FAIL';
  video_result?: Array<{ url: string; cover_image_url: string }>;
  error?: { code: string; message: string };
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

function readVideoTaskStatus(value: unknown): ZhipuVideoTaskResponse['task_status'] | undefined {
  if (value === 'PROCESSING' || value === 'SUCCESS' || value === 'FAIL') return value;
  return undefined;
}

function normalizeVideoResultItem(payload: unknown): { url: string; cover_image_url: string } | undefined {
  if (!isJsonRecord(payload)) return undefined;
  const url = readStringField(payload, 'url');
  if (!url) return undefined;
  return {
    url,
    cover_image_url: readStringField(payload, 'cover_image_url') || '',
  };
}

function normalizeZhipuVideoTaskResponse(payload: unknown): ZhipuVideoTaskResponse | undefined {
  if (!isJsonRecord(payload)) return undefined;
  const taskStatus = readVideoTaskStatus(payload.task_status);
  if (!taskStatus) return undefined;

  const response: ZhipuVideoTaskResponse = { task_status: taskStatus };
  const id = readStringField(payload, 'id');
  if (id) response.id = id;
  const model = readStringField(payload, 'model');
  if (model) response.model = model;

  const videoResult = readArrayField(payload, 'video_result')
    ?.map(normalizeVideoResultItem)
    .filter((item): item is { url: string; cover_image_url: string } => Boolean(item));
  if (videoResult) response.video_result = videoResult;

  const error = readRecordField(payload, 'error');
  if (error) {
    response.error = {
      code: readStringField(error, 'code') || 'UNKNOWN',
      message: readStringField(error, 'message') || '未知错误',
    };
  }

  return response;
}

// ── 工作区边界守卫（与 image 合同同一处 workspaceScope 助手，N-MEDIA-GEN-CONTRACT） ──

function outputPathOutsideWorkspace(resolved: string, ctx: ToolContext): boolean {
  if (isPathWithinRoot(resolved, ctx.workingDir)) return false;
  if (!ctx.workspaceScope) return true;
  return resolveWorkspacePath(ctx.workspaceScope, resolved, 'read_write') === undefined;
}

function resolveReadableWorkspacePath(candidate: string, ctx: ToolContext): string | undefined {
  const resolved = path.resolve(ctx.workingDir, candidate);
  if (isPathWithinRoot(resolved, ctx.workingDir)) return resolved;
  if (!ctx.workspaceScope) return undefined;
  return resolveWorkspacePath(ctx.workspaceScope, resolved, 'read')?.canonicalPath;
}

function workspaceRelativePath(absolutePath: string, ctx: ToolContext): string {
  if (ctx.workspaceScope) {
    const match = resolveWorkspacePath(ctx.workspaceScope, absolutePath, 'read');
    if (match) return match.relativePath || path.basename(absolutePath);
  }
  return path.relative(ctx.workingDir, absolutePath) || path.basename(absolutePath);
}

function imageInputMimeType(imagePath: string): string {
  switch (path.extname(imagePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function defaultVideoOutputPath(workingDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  return path.join(workingDir, DEFAULT_VIDEO_ARTIFACT_DIR, `generated-${timestamp}.mp4`);
}

/**
 * 参数校验（全部先于任何付费调用 / 进度事件 / 写盘）：旧 output_path 改名提示、
 * output_file_path 越界、image_path 越界/缺失/非图片/超 10MB、MiniMax 路由缺 key。
 */
function validateVideoGenerateArgs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { ok: true; params: VideoGenerateParams } | { ok: false; error: string; meta?: Record<string, unknown> } {
  if (Object.prototype.hasOwnProperty.call(args, 'output_path')) {
    return { ok: false, error: 'output_path was renamed to output_file_path; use output_file_path' };
  }

  const prompt = args.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { ok: false, error: 'prompt is required and must be a string' };
  }

  const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : GENERATION_TOOL_DEFAULT_MODELS.video;
  const zhipuRoute = model.startsWith('cogvideox');

  const rawImagePath = args.image_path;
  let imageDataUrl: string | undefined;
  let resolvedImagePath: string | undefined;
  if (rawImagePath !== undefined) {
    if (zhipuRoute) {
      return { ok: false, error: 'image_path is only supported on MiniMax models; cogvideox-* uses image_url' };
    }
    if (typeof rawImagePath !== 'string' || rawImagePath.length === 0) {
      return { ok: false, error: 'image_path must be a workspace path to a png, jpg, jpeg, or webp image' };
    }
    const resolved = resolveReadableWorkspacePath(rawImagePath, ctx);
    if (!resolved) return { ok: false, error: `image_path "${rawImagePath}" must be inside the workspace` };
    if (!IMAGE_INPUT_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) {
      return { ok: false, error: `image_path "${rawImagePath}" must be a png, jpg, jpeg, or webp file` };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, error: `image_path "${rawImagePath}" does not exist` };
    }
    if (!stat.isFile()) return { ok: false, error: `image_path "${rawImagePath}" does not exist` };
    if (stat.size > IMAGE_INPUT_MAX_BYTES) {
      return { ok: false, error: `image_path "${rawImagePath}" exceeds the 10 MB limit` };
    }
    resolvedImagePath = resolved;
    imageDataUrl = `data:${imageInputMimeType(resolved)};base64,${fs.readFileSync(resolved).toString('base64')}`;
  }

  const rawImageUrl = args.image_url;
  if (rawImageUrl !== undefined && !zhipuRoute) {
    return { ok: false, error: 'image_url is only valid with cogvideox-* models; use image_path for MiniMax image-to-video' };
  }
  const imageUrl = typeof rawImageUrl === 'string' && rawImageUrl.length > 0 ? rawImageUrl : undefined;

  const rawOutputFilePath = args.output_file_path;
  if (rawOutputFilePath !== undefined && typeof rawOutputFilePath !== 'string') {
    return { ok: false, error: 'output_file_path must be a workspace path' };
  }
  let outputFilePath: string;
  let explicitOutputFilePath: string | undefined;
  if (typeof rawOutputFilePath === 'string' && rawOutputFilePath.length > 0) {
    const resolvedOutputPath = path.resolve(ctx.workingDir, rawOutputFilePath);
    if (outputPathOutsideWorkspace(resolvedOutputPath, ctx)) {
      return {
        ok: false,
        error: `output_file_path "${resolvedOutputPath}" must be inside the workspace`,
        meta: { outputPath: resolvedOutputPath },
      };
    }
    outputFilePath = resolvedOutputPath;
    explicitOutputFilePath = resolvedOutputPath;
  } else {
    outputFilePath = defaultVideoOutputPath(ctx.workingDir);
  }

  if (!zhipuRoute && !getMinimaxApiKey()) {
    return { ok: false, error: 'MiniMax API key is missing: set MINIMAX_API_KEY or configure the minimax key slot in settings' };
  }

  return {
    ok: true,
    params: {
      prompt,
      zhipuRoute,
      model,
      imageDataUrl,
      resolvedImagePath,
      imageUrl,
      aspectRatio: typeof args.aspect_ratio === 'string' ? (args.aspect_ratio as VideoGenerateParams['aspectRatio']) : undefined,
      quality: typeof args.quality === 'string' ? (args.quality as VideoGenerateParams['quality']) : undefined,
      duration: typeof args.duration === 'number' ? (args.duration as VideoGenerateParams['duration']) : undefined,
      fps: typeof args.fps === 'number' ? (args.fps as VideoGenerateParams['fps']) : undefined,
      outputFilePath,
      explicitOutputFilePath,
    },
  };
}

/**
 * 复用指纹：只覆盖会改变这次付费请求的参数。调用方没传 output_file_path 时，
 * 时间戳默认路径不进指纹——重试靠账本找回上一次的文件。规则见 imageGenerateReuse.ts。
 */
function computeVideoGenerateFingerprint(params: VideoGenerateParams): string {
  const normalized = {
    prompt: params.prompt,
    model: params.model,
    image: params.resolvedImagePath
      ? { path: params.resolvedImagePath, contentSha256: sha256File(params.resolvedImagePath) }
      : null,
    imageUrl: params.imageUrl ?? null,
    aspectRatio: params.aspectRatio ?? null,
    quality: params.quality ?? null,
    duration: params.duration ?? null,
    fps: params.fps ?? null,
    outputFilePath: params.explicitOutputFilePath ?? null,
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** 命中账本：不调付费接口，把已落盘文件重新登记为本次调用的产物，并把账目归属改到本次 toolCallId。 */
async function deliverReusedVideo(input: {
  ctx: ToolContext;
  params: VideoGenerateParams;
  saved: GenerationLedgerSavedOutput;
  ledger: { ledgerDir: string; toolName: string; fingerprint: string };
}): Promise<ToolResult<string>> {
  const { ctx, saved, params } = input;
  const bytes = fs.statSync(saved.absolutePath).size;
  const artifact = await createFileArtifact(saved.absolutePath, input.ledger.toolName, ctx, {
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: bytes,
    metadata: {
      model: saved.actualModel,
      reused: true,
      prompt: params.prompt,
      mediaKind: 'video',
    },
  });
  recordGenerationSavedOutput({
    ctx,
    ...input.ledger,
    saved: {
      index: 1,
      absolutePath: saved.absolutePath,
      bytes,
      actualModel: saved.actualModel,
    },
  });
  const relativePath = workspaceRelativePath(saved.absolutePath, ctx);
  const perRequest: PerRequest[] = [{
    index: 1,
    status: 'saved',
    bytes,
    path: relativePath,
    reused: true,
  }];
  const output = `1/1 saved\n${REUSED_RESULT_LINE}\nper_request ${JSON.stringify(perRequest)}`;
  return {
    ok: true,
    output,
    meta: {
      artifact,
      artifacts: [artifact],
      per_request: perRequest,
      reused: true,
      model: saved.actualModel,
      videoPath: saved.absolutePath,
      outputPath: saved.absolutePath,
      prompt: params.prompt,
      mediaKind: 'video',
      contentLength: output.length,
      truncated: false,
      generationTimeMs: 0,
    },
  };
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
      `${MODEL_API_ENDPOINTS.zhipuOfficial}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: ZHIPU_OFFICIAL_QUICK_MODEL,
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
      logger.warn('video_generate prompt expand non-ok', { status: response.status });
      return shortPrompt;
    }

    const parsed = await parseChatCompletionHttpBody(response);
    if (parsed.kind !== 'payload') {
      logger.warn('video_generate prompt expand failed', {
        reason: parsed.kind === 'invalid' ? parsed.error : 'empty_response',
      });
      return shortPrompt;
    }
    const expandedPrompt = readChatCompletionText(parsed.payload);
    if (expandedPrompt) {
      return expandedPrompt;
    }
    logger.warn('video_generate prompt expand failed', { reason: 'empty_content' });
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
    `${MODEL_API_ENDPOINTS.zhipuOfficial}/videos/generations`,
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

  const result: unknown = await response.json();
  const taskId = isJsonRecord(result) ? readStringField(result, 'id') : undefined;
  if (!taskId) {
    throw new Error('智谱视频生成: 未返回任务 ID');
  }
  return taskId;
}

async function queryZhipuVideoTask(
  apiKey: string,
  taskId: string,
  outerSignal: AbortSignal,
): Promise<ZhipuVideoTaskResponse> {
  const response = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.zhipuOfficial}/async-result/${taskId}`,
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
  const result = normalizeZhipuVideoTaskResponse(await response.json());
  if (!result) {
    throw new Error('查询任务状态失败: 响应格式异常');
  }
  return result;
}

async function waitForZhipuVideoCompletion(
  apiKey: string,
  taskId: string,
  outerSignal: AbortSignal,
  emit: (msg: string) => void,
): Promise<{ videoUrl: string }> {
  const startTime = Date.now();

  while (Date.now() - startTime < TIMEOUT_MS.MAX_WAIT) {
    if (outerSignal.aborted) throw new Error('aborted');

    const result = await queryZhipuVideoTask(apiKey, taskId, outerSignal);

    if (result.task_status === 'SUCCESS') {
      if (!result.video_result || result.video_result.length === 0) {
        throw new Error('视频生成成功但未返回视频 URL');
      }
      return { videoUrl: result.video_result[0].url };
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

  const validation = validateVideoGenerateArgs(args, ctx);
  if (!validation.ok) {
    return { ok: false, error: validation.error, code: 'INVALID_ARGS', meta: validation.meta };
  }
  const params = validation.params;
  const outputPath = params.outputFilePath;
  const ledger = {
    ledgerDir: path.join(ctx.workingDir, DEFAULT_VIDEO_ARTIFACT_DIR),
    toolName: schema.name,
    fingerprint: computeVideoGenerateFingerprint(params),
  };
  const reusable = lookupReusableGenerationOutputs({ ctx, ...ledger })
    .find((saved) => saved.index === 1);
  if (reusable) {
    return deliverReusedVideo({ ctx, params, saved: reusable, ledger });
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

    let remoteUrl: string;
    let actualModel: string;
    let durationSec: number | undefined;
    let zhipuMeta: Record<string, unknown> | undefined;
    let engineLabel: string;

    if (params.zhipuRoute) {
      const zhipuApiKey = getZhipuOfficialVideoApiKey();
      if (!zhipuApiKey) {
        return {
          ok: false,
          error: TOOL_DEPENDENCY_HINTS.videoGenerateZhipuOfficial,
          code: 'NOT_INITIALIZED',
        };
      }
      engineLabel = 'CogVideoX (智谱)';

      ctx.emit({
        type: 'tool_output',
        tool: 'video_generate',
        message: '🎬 正在生成视频（可能需要 30-180 秒）...',
      } as never);

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
        params.imageUrl,
      );

      const aspectRatio = params.aspectRatio || '16:9';
      const size = VIDEO_SIZES[aspectRatio as keyof typeof VIDEO_SIZES] || VIDEO_SIZES['16:9'];

      const taskId = await submitZhipuVideoTask(
        zhipuApiKey,
        {
          prompt: expandedPrompt,
          imageUrl: params.imageUrl,
          size,
          quality: params.quality || 'quality',
          duration: params.duration || GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC,
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

      remoteUrl = taskResult.videoUrl;
      actualModel = params.model;
      zhipuMeta = {
        expandedPrompt,
        taskId,
        aspectRatio,
        duration: params.duration || GENERATION_TOOL_ZHIPU_VIDEO_DEFAULT_DURATION_SEC,
        fps: params.fps || 30,
      };
    } else {
      engineLabel = 'MiniMax 海螺';
      ctx.emit({
        type: 'tool_output',
        tool: 'video_generate',
        message: '🎬 正在生成视频（可能需要 30-180 秒）...',
      } as never);

      const generated = await generateVideo({
        model: params.imageDataUrl ? MINIMAX_I2V_MODEL : params.model,
        mode: params.imageDataUrl ? 'i2v' : 't2v',
        prompt: params.prompt,
        imageDataUrl: params.imageDataUrl,
        outerSignal: ctx.abortSignal,
      });
      remoteUrl = generated.url;
      actualModel = generated.actualModel;
      durationSec = generated.durationSec;
    }

    // 生成返回后、写盘前再查一次中止：用户已停止的请求不再落盘（对齐 image 合同返修）。
    if (ctx.abortSignal.aborted) throw new Error('aborted');

    let videoBuffer: Buffer;
    try {
      videoBuffer = await downloadVideoAsBuffer(remoteUrl, ctx.abortSignal);
      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outputPath, videoBuffer);
      recordGenerationSavedOutput({
        ctx,
        ...ledger,
        saved: {
          index: 1,
          absolutePath: outputPath,
          bytes: videoBuffer.length,
          actualModel,
        },
      });
    } catch (error: unknown) {
      if (ctx.abortSignal.aborted || (error instanceof Error && error.message === 'aborted')) throw error;
      ctx.logger.warn('video_generate save failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // 远端 URL 只进虚拟产物 metadata（image 合同同款例外），output/error 与 meta 其它位置不出现。
      const virtualArtifact = createVirtualArtifact({
        sourceTool: schema.name,
        kind: 'video',
        sessionId: ctx.sessionId,
        name: 'generated-video-1',
        mimeType: 'video/mp4',
        metadata: {
          generated: true,
          url: remoteUrl,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw new VideoSaveFailure('video was generated but could not be saved', virtualArtifact);
    }

    const generationTime = Date.now() - startTime;

    const artifact = await createFileArtifact(outputPath, schema.name, ctx, {
      kind: 'video',
      mimeType: 'video/mp4',
      sizeBytes: videoBuffer.length,
      metadata: {
        model: actualModel,
        engine: engineLabel,
        prompt: params.prompt,
        mediaKind: 'video',
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...zhipuMeta,
      },
    });

    const perRequest: PerRequest[] = [{
      index: 1,
      status: 'saved',
      bytes: videoBuffer.length,
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
        engine: engineLabel,
        videoPath: outputPath,
        outputPath,
        prompt: params.prompt,
        ...(zhipuMeta ?? {}),
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
    const perRequest: PerRequest[] = [{ index: 1, status: 'failed', error: message }];
    const artifacts = error instanceof VideoSaveFailure && error.artifact ? [error.artifact] : [];
    const summary = `0/1 saved\nper_request ${JSON.stringify(perRequest)}`;
    return {
      ok: false,
      error: summary,
      code: 'VIDEO_GENERATION_FAILED',
      meta: { artifacts, per_request: perRequest },
    };
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
