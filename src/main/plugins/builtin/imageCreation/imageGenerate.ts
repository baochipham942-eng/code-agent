// ============================================================================
// image_generate (P1 Wave 4 D2c — network/media: native ToolModule)
//
// CogView-4（智谱中文原生）+ FLUX.2（OpenRouter）双引擎 routing；
// prompt 双策略扩写；URL → base64 下载；文件保存可选；CLI 模式自动 open。
// 需要本地配置智谱或 OpenRouter API Key。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
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
import { createFileArtifact, createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { imageGenerateSchema as schema } from './imageGenerate.schema';
import {
  determineImageEngine,
  generateImage,
  downloadImageAsBase64,
  isImageUrl,
  type ImageEngine,
} from '../../../services/media/imageGenerationService';
import { readChatCompletionText } from '../typedResponseGuards';

const PROMPT_EXPAND_TIMEOUT_MS = 15000;
const GENERATED_MEDIA_CACHE_DIR = '.code-agent/media';

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

interface ImageGenerateParams {
  prompt: string;
  expand_prompt?: boolean;
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  output_path?: string;
  style?: 'photo' | 'illustration' | '3d' | 'anime';
}

function addStyleSuffix(prompt: string, style: string): string {
  return prompt + (STYLE_SUFFIXES[style] || '');
}

function getDataUrlMimeType(data: string): string | undefined {
  const match = data.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

function getImageExtension(imageData: string): string {
  const mimeMatch = imageData.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,/);
  const ext = mimeMatch?.[1]?.toLowerCase();
  if (!ext) return 'png';
  if (ext === 'jpeg') return 'jpg';
  if (ext === 'svg+xml') return 'svg';
  return ext.replace(/[^a-z0-9.-]/g, '') || 'png';
}

function imageBufferFromBase64(imageData: string): Buffer {
  const base64Data = imageData.replace(/^data:image\/[\w+.-]+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

function buildGeneratedMediaCachePath(workingDir: string, imageData: string, timestampMs: number): string {
  const timestamp = new Date(timestampMs).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = createHash('sha1').update(imageData).digest('hex').slice(0, 10);
  const ext = getImageExtension(imageData);
  return path.join(workingDir, GENERATED_MEDIA_CACHE_DIR, `generated-${timestamp}-${hash}.${ext}`);
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

async function expandPromptWithLLM(
  prompt: string,
  engine: ImageEngine,
  outerSignal: AbortSignal,
  logger: ToolContext['logger'],
  style?: string,
): Promise<string> {
  const configService = getConfigService();

  if (engine === 'cogview') {
    const zhipuApiKey = configService.getApiKey('zhipu')!;
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

      if (response.ok) {
        const expanded = readChatCompletionText(await response.json());
        if (expanded) return expanded;
      }
    } catch (e: unknown) {
      if (outerSignal.aborted) throw e;
      logger.warn('image_generate cogview prompt expand failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return style ? addStyleSuffix(prompt, style) : prompt;
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
  if (openrouterApiKey) {
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
      if (response.ok) {
        const expanded = readChatCompletionText(await response.json());
        if (expanded) return expanded;
      }
    } catch (e: unknown) {
      if (outerSignal.aborted) throw e;
      logger.warn('image_generate flux prompt expand failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return style ? addStyleSuffix(prompt, style) : prompt;
}

export async function executeImageGenerate(
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

  const params = args as unknown as ImageGenerateParams;
  if (typeof params.prompt !== 'string' || params.prompt.length === 0) {
    return { ok: false, error: 'prompt is required and must be a string', code: 'INVALID_ARGS' };
  }

  const startTime = Date.now();
  const aspectRatio = params.aspect_ratio || '1:1';
  const expandPrompt = params.expand_prompt ?? false;
  const style = params.style;
  let outputPath = params.output_path;

  if (!outputPath && process.env.CODE_AGENT_CLI_MODE === 'true') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    outputPath = path.join(ctx.workingDir, `generated-${timestamp}.png`);
  }

  try {
    const engine = determineImageEngine();
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    const isAdmin = user?.isAdmin ?? false;
    const fluxModel = isAdmin ? FLUX_MODELS.pro : FLUX_MODELS.schnell;

    const engineLabel =
      engine === 'cogview'
        ? 'CogView-4 (智谱)'
        : `FLUX (${isAdmin ? 'Pro' : 'Schnell'})`;

    ctx.emit({
      type: 'tool_output',
      tool: 'image_generate',
      message: `🎨 使用模型: ${engineLabel}`,
    } as never);

    let finalPrompt = params.prompt;
    if (expandPrompt) {
      ctx.emit({
        type: 'tool_output',
        tool: 'image_generate',
        message: '✨ 正在扩展优化 prompt...',
      } as never);
      finalPrompt = await expandPromptWithLLM(params.prompt, engine, ctx.abortSignal, ctx.logger, style);
    } else if (style) {
      finalPrompt = addStyleSuffix(params.prompt, style);
    }

    ctx.emit({
      type: 'tool_output',
      tool: 'image_generate',
      message: '🖼️ 正在生成图片（可能需要 10-30 秒）...',
    } as never);

    const { imageData: rawImageData, actualModel } = await generateImage(
      engine,
      fluxModel,
      finalPrompt,
      aspectRatio,
      ctx.abortSignal,
    );

    let imageBase64: string;
    if (isImageUrl(rawImageData)) {
      ctx.emit({
        type: 'tool_output',
        tool: 'image_generate',
        message: '📥 正在下载图片...',
      } as never);
      try {
        imageBase64 = await downloadImageAsBase64(rawImageData, ctx.abortSignal);
      } catch (e: unknown) {
        if (ctx.abortSignal.aborted) throw e;
        ctx.logger.warn('image_generate download fallback to URL', {
          error: e instanceof Error ? e.message : String(e),
        });
        imageBase64 = rawImageData;
      }
    } else {
      imageBase64 = rawImageData;
    }

    let imagePath: string | undefined;
    let savedImageSizeBytes: number | undefined;
    const cachePath = !outputPath && !isImageUrl(imageBase64)
      ? buildGeneratedMediaCachePath(ctx.workingDir, imageBase64, startTime)
      : undefined;
    const targetPath = outputPath || cachePath;
    const cachedInlineImage = Boolean(cachePath && !outputPath);

    if (targetPath) {
      const resolvedPath = path.isAbsolute(targetPath)
        ? targetPath
        : path.join(ctx.workingDir, targetPath);

      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const imageBuffer = imageBufferFromBase64(imageBase64);
      fs.writeFileSync(resolvedPath, imageBuffer);
      imagePath = resolvedPath;
      savedImageSizeBytes = imageBuffer.length;

      if (outputPath && process.env.CODE_AGENT_CLI_MODE === 'true' && fs.existsSync(resolvedPath)) {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        safeExecDetached(openCmd, [resolvedPath], (err: Error) => {
          ctx.logger.warn('image_generate auto-open failed', { error: err.message });
        });
      }
    }

    const generationTime = Date.now() - startTime;

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output: outputPath && imagePath ? `图片生成成功。Saved to: ${imagePath}` : '图片生成成功。',
      meta: {
        artifact: imagePath
          ? await createFileArtifact(imagePath, schema.name, ctx, {
            kind: 'image',
            mimeType: getDataUrlMimeType(imageBase64),
            sizeBytes: savedImageSizeBytes,
            metadata: {
              model: actualModel,
              engine,
              aspectRatio,
              generationTimeMs: generationTime,
              isAdmin,
              cachedInlineImage,
            },
          })
          : createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'image',
            sessionId: ctx.sessionId,
            name: 'generated-image',
            url: isImageUrl(imageBase64) ? imageBase64 : undefined,
            mimeType: getDataUrlMimeType(imageBase64) ?? 'image/png',
            contentLength: imageBase64.length,
            metadata: {
              model: actualModel,
              engine,
              aspectRatio,
              generationTimeMs: generationTime,
              isAdmin,
              embeddedBase64: !isImageUrl(imageBase64),
            },
          }),
        model: actualModel,
        engine,
        originalPrompt: params.prompt,
        expandedPrompt: expandPrompt ? finalPrompt : undefined,
        imagePath,
        imageBase64: imagePath ? undefined : imageBase64,
        cachedInlineImage,
        aspectRatio,
        generationTimeMs: generationTime,
        isAdmin,
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
    ctx.logger.warn('image_generate failed', { error: message });
    return { ok: false, error: `图片生成失败: ${message}` };
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
