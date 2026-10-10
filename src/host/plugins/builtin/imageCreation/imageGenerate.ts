// ============================================================================
// image_generate (P1 Wave 4 D2c — network/media: native ToolModule)
//
// CogView-4（智谱中文原生）+ FLUX.2（OpenRouter）双引擎 routing；
// prompt 双策略扩写；URL → base64 下载；默认保存为文件 artifact；CLI 模式自动 open。
// 需要本地配置智谱或 OpenRouter API Key。
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
import { safeExecDetached } from '../../../utils/safeShell';
import { getConfigService } from '../../../services';
import { getAuthService } from '../../../services/auth/authService';
import { MODEL_API_ENDPOINTS, DEFAULT_MODELS } from '../../../../shared/constants';
import type { ToolArtifact } from '../../../../shared/contract/artifactBlob';
import { createFileArtifact, createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { buildMediaArtifactMetadata } from '../../../tools/artifacts/mediaArtifactMetadata';
import { imageGenerateSchema as schema } from './imageGenerate.schema';
import { isPathWithinRoot, resolveWorkspacePath } from '../../../runtime/workspaceScope';
import { runImageGenerateBatch } from './imageGenerateRequests';
import {
  determineImageEngine,
  generateImage,
  generateImageFromReference,
  downloadImageAsBase64,
  type ImageEngine,
} from '../../../services/media/imageGenerationService';
import { readChatCompletionText } from '../typedResponseGuards';
import { parseChatCompletionHttpBody } from '../../../model/parseSseChatCompletion';
import {
  aspectOrientation,
  aspectRatioMatches,
  parsePngDimensions,
} from '../../../../shared/media/imageNarration';

const PROMPT_EXPAND_TIMEOUT_MS = 15000;

const FLUX_MODELS = {
  pro: 'black-forest-labs/flux.2-pro',
  schnell: 'black-forest-labs/flux.2-klein-4b',
} as const;

const PROMPT_EXPAND_MODEL = 'deepseek/deepseek-chat';

const STYLE_SUFFIXES: Record<string, string> = {
  photo: ', photorealistic, high resolution, professional photography, sharp focus',
  illustration: ', digital illustration, detailed artwork, vibrant colors, artistic',
  '3d': ', 3D render, octane render, realistic lighting, detailed textures, volumetric',
  anime: ', anime style, detailed anime artwork, vibrant colors, studio quality',
};

const DEFAULT_IMAGE_ARTIFACT_DIR = path.join('.code-agent', 'artifacts', 'images');

const COGVIEW4_EXPAND_PROMPT = `你是专业的 AI 图片提示词工程师，专门为 CogView4 图像生成模型优化提示词。将用户的简短描述扩展为高质量的图片生成提示词。

## 提示词结构公式

主体(含外观细节) + 环境/场景 + 光影 + 构图/视角 + 风格/媒介 + 氛围/情绪

## 核心规则

1. **中文输出**：CogView4 使用 GLM 编码器，中文理解能力强，直接输出中文
2. **丰富细节**：CogView4 用长合成描述训练，丰富的描述效果显著优于简短 prompt
3. **主体具体**：描述外观特征（发型/服装/材质/颜色/纹理），避免泛泛的"一个人"
4. **光影明确**：指定光源方向和类型（自然光/逆光/侧光/柔光/硬光/体积光/丁达尔效应/黄金时刻光线）
5. **构图专业**：使用摄影构图术语（三分法/居中对称/对角线/框架构图/引导线/俯拍/仰拍/平视）
6. **相机引用提升品质**：适当引用镜头参数（85mm f/1.4 浅景深/35mm 广角/微距镜头）
7. **正面描述**：描述你要什么，而非不要什么
8. **绝对禁止文字**：生成的提示词中不得要求画面包含任何文字、字母、数字、标题、标签
9. **控制在 200 字以内**
10. **直接输出优化后的提示词，不要解释**`;

const FLUX2_EXPAND_PROMPT = `You are an expert image prompt engineer optimizing prompts for FLUX.2 image generation.

## Prompt Structure

Subject (with appearance) + Environment + Lighting + Composition/Camera + Style/Medium + Mood

## Core Rules

1. **English output**: FLUX.2 performs best with English natural language
2. **Natural language over keywords**: Write descriptive prose, NOT comma-separated tags
3. **No weight syntax**: Do NOT use (element:1.3) or [[brackets]] — FLUX ignores them
4. **No negative prompts**: Describe what you WANT, not what to avoid
5. **Camera/lens references boost quality**: "Shot on Sony A7IV, 85mm f/1.2"
6. **Specific over generic**: "weathered oak table" not "table"
7. **NEVER include text**: The prompt MUST NOT ask for any text, letters, numbers, labels
8. **30-80 words sweet spot**: Too short lacks control, too long dilutes attention
9. **Output only the enhanced prompt, no explanation**`;

interface ValidatedImageGenerateParams {
  prompts: string[];
  referencePaths: string[];
  expandPrompt: boolean;
  aspectRatio: string;
  outputFilePath?: string;
  style?: string;
}

interface SavedImage {
  absolutePath: string;
  relativePath: string;
  bytes: number;
  artifact: ToolArtifact;
  verdict: string;
  actualModel: string;
  finalPrompt: string;
  imageBase64: string;
  mimeType: string;
  generationTimeMs: number;
  dimensions?: { width: number; height: number };
}

interface PerRequest {
  index: number;
  status: 'saved' | 'failed';
  bytes?: number;
  path?: string;
  error?: string;
}

class ImageGenerateRequestFailure extends Error {
  readonly artifact?: ToolArtifact;

  constructor(message: string, artifact?: ToolArtifact) {
    super(message);
    this.name = 'ImageGenerateRequestFailure';
    this.artifact = artifact;
  }
}

// ---------------------------------------------------------------------------
// 出图前复述 / 出图后验收（工单 2026-07-31）
//
// 出图花真钱且要等十几秒到一分钟，所以动手前先把「我理解你要什么」原样回显一遍，
// 让用户在掏钱前就能发现理解错了并打断；出完再给一句能对着图核对的具体陈述。
//
// 铁律：这两句都只由**已知参数和产出物的实测值**拼成，不再过一遍模型，
// 也绝不改动真正发给出图模型的 prompt——它是回显，不是新一层 prompt 加工。
// 也不写「已完成 / 生成成功」这类可被润色的状态词：验收句只说数字和路径，
// 说不出具体内容的项就整项省掉，不拿套话占位。
// ---------------------------------------------------------------------------

const ORIENTATION_LABELS: Record<string, string> = {
  portrait: '竖版',
  landscape: '横版',
  square: '方图',
};

const STYLE_LABELS: Record<string, string> = {
  photo: '写实照片',
  illustration: '插画',
  '3d': '3D 渲染',
  anime: '动漫',
};

/** 「9:16 竖版」；未知比例只回原字符串，不猜朝向。 */
function aspectRatioLabel(ratio: string): string {
  const orientation = aspectOrientation(ratio);
  const label = orientation ? ORIENTATION_LABELS[orientation] : undefined;
  return label ? `${ratio} ${label}` : ratio;
}

/** 出图前复述句：全部来自入参回显，零模型调用、零额外耗时。 */
function buildBriefing(params: {
  prompt: string;
  aspectRatio: string;
  style?: string;
  expandPrompt: boolean;
  engineLabel: string;
  outputPath: string;
}): string {
  const lines = [
    `我理解你要的是：${params.prompt}`,
    `· 画面比例 ${aspectRatioLabel(params.aspectRatio)}，出图模型 ${params.engineLabel}`,
  ];
  const styleLabel = params.style ? STYLE_LABELS[params.style] : undefined;
  if (styleLabel) lines.push(`· 风格 ${styleLabel}`);
  if (params.expandPrompt) {
    lines.push('· 会先让文本模型把这句话扩写成出图提示词，再拿扩写结果去出图');
  } else {
    lines.push('· 上面这句话原样送给出图模型，不额外加工');
  }
  // 「不做什么」这条有实据：imageGenerationService 对三个引擎一律追加 NO_TEXT_SUFFIX，
  // 与 expand_prompt 开关无关，所以这句可以无条件说。
  lines.push('· 画面里不会出现文字、字母、数字、水印、签名');
  lines.push(`· 出完存到 ${params.outputPath}`);
  lines.push('接下来是真实付费调用（约 10-30 秒）。理解错了现在打断还来得及。');
  return lines.join('\n');
}

/** 把字节数说成人话，供验收句核对文件。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 出图后验收句：只陈述能对着产出物核对的事实（实际像素/是否符合所要比例/实际模型/
 * 用时/落盘路径与大小）。测不到的项直接不写——例如非 PNG 读不出尺寸时就没有尺寸那条，
 * 而不是退回「生成成功」这种空话。
 */
function buildVerdict(params: {
  aspectRatio: string;
  actualModel: string;
  engineLabel: string;
  dimensions?: { width: number; height: number };
  generationTimeMs: number;
  imagePath?: string;
  sizeBytes?: number;
}): string {
  const lines: string[] = [];

  if (params.dimensions) {
    const { width, height } = params.dimensions;
    const matches = aspectRatioMatches(width, height, params.aspectRatio);
    if (matches === true) {
      lines.push(`· 实际尺寸 ${width}×${height}，与你要的 ${params.aspectRatio} 相符`);
    } else if (matches === false) {
      lines.push(
        `· 实际尺寸 ${width}×${height}（约 ${(width / height).toFixed(3)}:1），` +
        `与你要的 ${params.aspectRatio} 不符——出图模型没按比例出，需要重来请说一声`,
      );
    } else {
      lines.push(`· 实际尺寸 ${width}×${height}`);
    }
  }

  lines.push(`· 出图模型 ${params.actualModel}（${params.engineLabel}），用时 ${(params.generationTimeMs / 1000).toFixed(1)} 秒`);

  if (params.imagePath) {
    const size = params.sizeBytes !== undefined ? `，${formatBytes(params.sizeBytes)}` : '';
    lines.push(`· 落盘 ${params.imagePath}${size}`);
  } else {
    lines.push('· 未落盘为文件，图片以内联数据返回');
  }

  return `出图结果（请对照图核对）：\n${lines.join('\n')}`;
}

function addStyleSuffix(prompt: string, style: string): string {
  return prompt + (STYLE_SUFFIXES[style] || '');
}

function getDataUrlMimeType(data: string): string | undefined {
  const match = data.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

function isRemoteImageData(data: string): boolean {
  return data.startsWith('http://') || data.startsWith('https://');
}

function defaultImageOutputPath(workingDir: string, timestamp: string, index: number): string {
  return path.join(workingDir, DEFAULT_IMAGE_ARTIFACT_DIR, `generated-${timestamp}-${index}.png`);
}

/** Caller-supplied output_file_path only. The default artifact path is not passed here. */
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

function indexedOutputPath(basePath: string, index: number, count: number): string {
  if (count <= 1) return basePath;
  const extension = path.extname(basePath);
  return extension
    ? `${basePath.slice(0, -extension.length)}-${index}${extension}`
    : `${basePath}-${index}`;
}

function referenceMimeType(referencePath: string): string {
  switch (path.extname(referencePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

function readReferenceAsDataUrl(referencePath: string): string {
  return `data:${referenceMimeType(referencePath)};base64,${fs.readFileSync(referencePath).toString('base64')}`;
}

function validateImageGenerateArgs(
  args: Record<string, unknown>,
  ctx: ToolContext,
): { ok: true; params: ValidatedImageGenerateParams } | { ok: false; error: string; meta?: Record<string, unknown> } {
  if (Object.prototype.hasOwnProperty.call(args, 'output_path')) {
    return { ok: false, error: 'output_path was renamed to output_file_path; use output_file_path' };
  }

  const rawPrompt = args.prompt;
  let prompts: string[];
  if (typeof rawPrompt === 'string') {
    prompts = [rawPrompt];
  } else if (Array.isArray(rawPrompt)) {
    if (rawPrompt.some((prompt) => typeof prompt !== 'string')) {
      return { ok: false, error: 'prompt items must be non-empty strings' };
    }
    prompts = rawPrompt.reduce<string[]>((items, prompt) => {
      items.push(prompt as string);
      return items;
    }, []);
  } else {
    return { ok: false, error: 'prompt must be an array of strings' };
  }
  if (prompts.length < 1) return { ok: false, error: 'prompt must contain at least one item' };
  if (prompts.length > 10) return { ok: false, error: 'prompt cannot contain more than 10 items' };
  if (prompts.some((prompt) => typeof prompt !== 'string' || prompt.length === 0)) {
    return { ok: false, error: 'prompt items must be non-empty strings' };
  }

  const rawReferences = args.reference_images;
  if (rawReferences !== undefined && !Array.isArray(rawReferences)) {
    return { ok: false, error: 'reference_images must be an array of workspace paths' };
  }
  const referenceValues = rawReferences === undefined ? [] : rawReferences;
  if (referenceValues.length > 4) {
    return { ok: false, error: 'reference_images cannot contain more than 4 items' };
  }

  const referencePaths: string[] = [];
  for (const reference of referenceValues) {
    if (typeof reference !== 'string' || reference.length === 0) {
      return { ok: false, error: 'reference_images items must be non-empty strings' };
    }
    const resolved = resolveReadableWorkspacePath(reference, ctx);
    if (!resolved) return { ok: false, error: `reference image "${reference}" must be inside the workspace` };
    const extension = path.extname(resolved).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
      return { ok: false, error: `reference image "${reference}" must be a png, jpg, jpeg, or webp file` };
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return { ok: false, error: `reference image "${reference}" does not exist` };
    }
    if (!stat.isFile()) return { ok: false, error: `reference image "${reference}" does not exist` };
    if (stat.size > 10 * 1024 * 1024) {
      return { ok: false, error: `reference image "${reference}" exceeds the 10 MB limit` };
    }
    referencePaths.push(resolved);
  }

  const outputFilePath = args.output_file_path;
  if (outputFilePath !== undefined && typeof outputFilePath !== 'string') {
    return { ok: false, error: 'output_file_path must be a workspace path' };
  }
  if (typeof outputFilePath === 'string' && outputFilePath.length > 0) {
    const resolvedOutputPath = path.resolve(ctx.workingDir, outputFilePath);
    if (outputPathOutsideWorkspace(resolvedOutputPath, ctx)) {
      return {
        ok: false,
        error: `output_file_path "${resolvedOutputPath}" must be inside the workspace`,
        meta: { outputPath: resolvedOutputPath },
      };
    }
  }

  return {
    ok: true,
    params: {
      prompts,
      referencePaths,
      expandPrompt: args.expand_prompt === true,
      aspectRatio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio : '1:1',
      outputFilePath: typeof outputFilePath === 'string' && outputFilePath.length > 0
        ? path.resolve(ctx.workingDir, outputFilePath)
        : undefined,
      style: typeof args.style === 'string' ? args.style : undefined,
    },
  };
}

// expandPromptWithLLM 还需要一个带超时的 fetch helper，独立于 service。
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

async function readExpandedPromptFromResponse(
  response: Response,
  logger: ToolContext['logger'],
  event: string,
): Promise<string | undefined> {
  const parsed = await parseChatCompletionHttpBody(response);
  if (parsed.kind !== 'payload') {
    logger.warn(event, {
      reason: parsed.kind === 'invalid' ? parsed.error : 'empty_response',
    });
    return undefined;
  }
  const expanded = readChatCompletionText(parsed.payload);
  if (!expanded) {
    logger.warn(event, { reason: 'empty_content' });
    return undefined;
  }
  return expanded;
}

async function expandPromptWithLLM(
  prompt: string,
  engine: ImageEngine,
  outerSignal: AbortSignal,
  logger: ToolContext['logger'],
  style?: string,
): Promise<string> {
  const configService = getConfigService();
  const fallback = style ? addStyleSuffix(prompt, style) : prompt;

  if (engine === 'cogview') {
    const zhipuApiKey = configService.getApiKey('zhipu') ?? '';
    const userPrompt = style ? `风格: ${style}\n描述: ${prompt}` : prompt;
    try {
      const response = await fetchWithAbort(
        `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${zhipuApiKey}`,
          },
          body: JSON.stringify({
            model: DEFAULT_MODELS.quick,
            messages: [
              { role: 'system', content: COGVIEW4_EXPAND_PROMPT },
              { role: 'user', content: userPrompt },
            ],
            max_tokens: 1000,
          }),
        },
        PROMPT_EXPAND_TIMEOUT_MS,
        outerSignal,
      );

      if (!response.ok) {
        logger.warn('image_generate cogview prompt expand failed', {
          reason: 'http_error',
          status: response.status,
        });
        return fallback;
      }
      const expanded = await readExpandedPromptFromResponse(
        response,
        logger,
        'image_generate cogview prompt expand failed',
      );
      if (expanded) return expanded;
    } catch (e: unknown) {
      if (outerSignal.aborted) throw e;
      logger.warn('image_generate cogview prompt expand failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return fallback;
  }

  // engine === 'flux': OpenRouter 英文扩写
  const userPrompt = style ? `Style: ${style}\nDescription: ${prompt}` : prompt;
  const fluxRequestBody = {
    model: PROMPT_EXPAND_MODEL,
    messages: [
      { role: 'system', content: FLUX2_EXPAND_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 500,
  };

  const openrouterApiKey = configService.getApiKey('openrouter');
  if (!openrouterApiKey) {
    logger.warn('image_generate flux prompt expand failed', { reason: 'missing_api_key' });
    return fallback;
  }
  try {
    const response = await fetchWithAbort(
      `${MODEL_API_ENDPOINTS.openrouter}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openrouterApiKey}`,
          'HTTP-Referer': 'https://code-agent.app',
          'X-Title': 'Agent Neo',
        },
        body: JSON.stringify(fluxRequestBody),
      },
      PROMPT_EXPAND_TIMEOUT_MS,
      outerSignal,
    );
    if (!response.ok) {
      logger.warn('image_generate flux prompt expand failed', {
        reason: 'http_error',
        status: response.status,
      });
      return fallback;
    }
    const expanded = await readExpandedPromptFromResponse(
      response,
      logger,
      'image_generate flux prompt expand failed',
    );
    if (expanded) return expanded;
  } catch (e: unknown) {
    if (outerSignal.aborted) throw e;
    logger.warn('image_generate flux prompt expand failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return fallback;
}



export async function executeImageGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: 'permission denied: ' + permit.reason, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }
  const validation = validateImageGenerateArgs(args, ctx);
  if (!validation.ok) {
    return { ok: false, error: validation.error, code: 'INVALID_ARGS', meta: validation.meta };
  }
  const params = validation.params;
  const count = params.prompts.length;
  onProgress?.({ stage: 'starting', detail: schema.name });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  const outputPathFor = (index: number): string => params.outputFilePath
    ? indexedOutputPath(params.outputFilePath, index, count)
    : defaultImageOutputPath(ctx.workingDir, timestamp, index);
  const startTime = Date.now();
  let briefed = false;
  const emitLive = (content: string): void => {
    if (!ctx.currentToolCallId) return;
    ctx.emit({
      type: 'tool_output_delta',
      data: {
        toolCallId: ctx.currentToolCallId,
        toolName: schema.name,
        stream: 'stdout',
        content,
        elapsedMs: Date.now() - startTime,
      },
    });
  };
  try {
    const engine = determineImageEngine();
    const user = getAuthService().getCurrentUser();
    const isAdmin = user?.isAdmin ?? false;
    const fluxModel = isAdmin ? FLUX_MODELS.pro : FLUX_MODELS.schnell;
    const engineLabel = engine === 'cogview'
      ? 'CogView-4 (智谱)'
      : 'FLUX (' + (isAdmin ? 'Pro' : 'Schnell') + ')';
    const firstOutputPath = workspaceRelativePath(outputPathFor(1), ctx);
    emitLive(buildBriefing({
      prompt: count > 1 ? params.prompts[0] + '（以及另外 ' + (count - 1) + ' 条）' : params.prompts[0],
      aspectRatio: params.aspectRatio,
      style: params.style,
      expandPrompt: params.expandPrompt,
      engineLabel,
      outputPath: firstOutputPath,
    }));
    if (ctx.currentToolCallId) {
      ctx.emit({
        type: 'artifact_write_started',
        data: {
          toolCallId: ctx.currentToolCallId,
          toolName: schema.name,
          filePath: outputPathFor(1),
        },
      });
    }
    briefed = true;
    const referenceDataUrl = params.referencePaths[0]
      ? readReferenceAsDataUrl(params.referencePaths[0])
      : undefined;
    const batch = await runImageGenerateBatch({
      requests: params.prompts.map((prompt, index) => ({ index: index + 1, prompt })),
      signal: ctx.abortSignal,
      concurrency: 3,
      run: async (request): Promise<SavedImage> => {
        if (ctx.abortSignal.aborted) throw new Error('aborted');
        const requestStart = Date.now();
        const outputPath = outputPathFor(request.index);
        const unexpandedPrompt = params.style ? addStyleSuffix(request.prompt, params.style) : request.prompt;
        let finalPrompt = request.prompt;
        if (params.expandPrompt) {
          finalPrompt = await expandPromptWithLLM(
            request.prompt, engine, ctx.abortSignal, ctx.logger, params.style,
          );
          if (finalPrompt === unexpandedPrompt) {
            emitLive('更正：扩写没成功（模型没返回可用结果），改为把你的原话原样送去出图。');
          }
        } else if (params.style) {
          finalPrompt = unexpandedPrompt;
        }
        const generated = referenceDataUrl
          ? await generateImageFromReference({
            prompt: finalPrompt,
            referenceImageDataUrl: referenceDataUrl,
          })
          : await generateImage(engine, fluxModel, finalPrompt, params.aspectRatio, ctx.abortSignal);
        let imageBase64 = generated.imageData;
        if (isRemoteImageData(imageBase64)) {
          try {
            imageBase64 = await downloadImageAsBase64(imageBase64, ctx.abortSignal);
          } catch (error: unknown) {
            if (ctx.abortSignal.aborted) throw error;
            const remoteArtifact = createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'image',
              sessionId: ctx.sessionId,
              name: 'generated-image-' + request.index,
              mimeType: 'image/png',
              contentLength: generated.imageData.length,
              metadata: {
                generated: true,
                url: generated.imageData,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            throw new ImageGenerateRequestFailure('image was generated but could not be saved', remoteArtifact);
          }
        }
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const imageBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        fs.writeFileSync(outputPath, imageBuffer);
        const generationTimeMs = Date.now() - requestStart;
        const dimensions = parsePngDimensions(imageBuffer);
        const mimeType = getDataUrlMimeType(imageBase64) ?? referenceMimeType(outputPath);
        const mediaArtifactMetadata = buildMediaArtifactMetadata(ctx, {
          kind: 'generated-image',
          operation: 'generate',
          sourcePrompt: request.prompt,
          fallbackStrategy: 'file-artifact',
        });
        const artifact = await createFileArtifact(outputPath, schema.name, ctx, {
          kind: 'image',
          mimeType,
          sizeBytes: imageBuffer.length,
          metadata: {
            model: generated.actualModel,
            engine,
            aspectRatio: params.aspectRatio,
            generationTimeMs,
            isAdmin,
            autoPersisted: !params.outputFilePath,
            ...(params.referencePaths.length
              ? { referencesUsed: '1 of ' + params.referencePaths.length }
              : {}),
            ...mediaArtifactMetadata,
          },
        });
        const verdict = buildVerdict({
          aspectRatio: params.aspectRatio,
          actualModel: generated.actualModel,
          engineLabel,
          dimensions,
          generationTimeMs,
          imagePath: workspaceRelativePath(outputPath, ctx),
          sizeBytes: imageBuffer.length,
        }) + (params.referencePaths.length
          ? '\n· references used: 1 of ' + params.referencePaths.length
          : '');
        if (process.env.CODE_AGENT_CLI_MODE === 'true' && fs.existsSync(outputPath)) {
          const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
          safeExecDetached(openCmd, [outputPath], (error: Error) => {
            ctx.logger.warn('image_generate auto-open failed', { error: error.message });
          });
        }
        return {
          absolutePath: outputPath,
          relativePath: workspaceRelativePath(outputPath, ctx),
          bytes: imageBuffer.length,
          artifact,
          verdict,
          actualModel: generated.actualModel,
          finalPrompt,
          imageBase64,
          mimeType,
          generationTimeMs,
          dimensions,
        };
      },
    });
    const perRequest: PerRequest[] = batch.map((result) => result.status === 'saved'
      ? { index: result.index, status: 'saved', bytes: result.value?.bytes, path: result.value?.relativePath }
      : {
        index: result.index,
        status: 'failed',
        error: result.error === 'aborted'
          ? 'aborted'
          : params.prompts[result.index - 1] + ': ' + (result.error || 'image generation failed'),
      });
    const saved = batch.filter((result): result is typeof result & { value: SavedImage } => (
      result.status === 'saved' && Boolean(result.value)
    ));
    const artifacts = [
      ...saved.map((result) => result.value.artifact),
      ...batch.map((result) => result.artifact).filter((artifact): artifact is ToolArtifact => Boolean(artifact)),
    ];
    const outputLines = [
      saved.length + '/' + count + ' saved',
      'per_request ' + JSON.stringify(perRequest),
      ...saved.map((result) => result.value.verdict),
    ];
    if (saved.length === 0 && perRequest[0]?.error) {
      outputLines.push(
        '上面说要出的那张「' + aspectRatioLabel(params.aspectRatio) + '：' + params.prompts[0]
          + '」没有出成：' + perRequest[0].error + '。没有生成，磁盘上没有新图。',
      );
    }
    const output = outputLines.join('\n');
    onProgress?.({ stage: 'completing', percent: 100 });
    if (saved.length === 0) {
      return {
        ok: false,
        error: output,
        code: ctx.abortSignal.aborted ? 'ABORTED' : 'IMAGE_GENERATION_FAILED',
        meta: { artifacts, per_request: perRequest },
      };
    }
    const first = saved[0].value;
    const meta: Record<string, unknown> = {
      artifact: first.artifact,
      artifacts,
      per_request: perRequest,
      model: first.actualModel,
      engine,
      originalPrompt: params.prompts[0],
      expandedPrompt: params.expandPrompt ? first.finalPrompt : undefined,
      imagePath: first.absolutePath,
      outputPath: first.absolutePath,
      imageBase64: undefined,
      aspectRatio: params.aspectRatio,
      generationTimeMs: first.generationTimeMs,
      isAdmin,
    };
    if (count > 1) {
      meta.imagePaths = saved.map((result) => result.value.absolutePath);
      meta.originalPrompts = params.prompts;
      meta.expandedPrompts = params.expandPrompt
        ? saved.map((result) => result.value.finalPrompt)
        : undefined;
    }
    emitLive(output);
    return { ok: true, output, meta };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted || (error instanceof Error && error.message === 'aborted')) {
      const perRequest = params.prompts.map((_, index) => ({
        index: index + 1,
        status: 'failed' as const,
        error: 'aborted',
      }));
      const output = '0/' + count + ' saved\nper_request ' + JSON.stringify(perRequest);
      return { ok: false, error: output, code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('image_generate failed', { error: message });
    if (!briefed) return { ok: false, error: '图片生成失败: ' + message };
    return { ok: false, error: '图片生成失败：' + message };
  }
}

class ImageGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeImageGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const imageGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ImageGenerateHandler();
  },
};
