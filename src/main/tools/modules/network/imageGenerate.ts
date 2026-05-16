// ============================================================================
// image_generate (P1 Wave 4 D2c — network/media: native ToolModule)
//
// CogView-4（智谱中文原生）+ FLUX.2（OpenRouter）双引擎 routing；
// prompt 双策略扩写；URL → base64 下载；文件保存可选；CLI 模式自动 open。
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
import { createFileArtifact, createVirtualArtifact } from '../../artifacts/artifactMeta';
import { imageGenerateSchema as schema } from './imageGenerate.schema';

export type ImageEngine = 'cogview' | 'flux';

const TIMEOUT_MS = {
  DIRECT_API: 90000,
  PROMPT_EXPAND: 15000,
  IMAGE_DOWNLOAD: 30000,
};

const FLUX_MODELS = {
  pro: 'black-forest-labs/flux.2-pro',
  schnell: 'black-forest-labs/flux.2-klein-4b',
} as const;

const PROMPT_EXPAND_MODEL = 'deepseek/deepseek-chat';

const ZHIPU_IMAGE_MODELS = {
  standard: 'cogview-4-250304',
  legacy: 'cogview-3-flash',
} as const;

const NO_TEXT_SUFFIX = '，画面中不要出现任何文字、字母、数字、标题、标签、水印、签名，纯视觉画面';

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

interface GenerateResult {
  imageData: string;
  actualModel: string;
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

function getZhipuOfficialApiKey(): string | undefined {
  const officialKey = process.env.ZHIPU_OFFICIAL_API_KEY;
  if (officialKey) return officialKey;
  const configService = getConfigService();
  const zhipuKey = configService.getApiKey('zhipu');
  if (zhipuKey && !zhipuKey.startsWith('oki-')) return zhipuKey;
  return undefined;
}

export function determineImageEngine(): ImageEngine {
  if (getZhipuOfficialApiKey()) return 'cogview';
  const configService = getConfigService();
  if (configService.getApiKey('openrouter')) return 'flux';
  throw new Error('图片生成需要本地 API Key：请在设置中配置智谱（CogView-4）或 OpenRouter（FLUX）API Key。');
}

function addStyleSuffix(prompt: string, style: string): string {
  return prompt + (STYLE_SUFFIXES[style] || '');
}

export function isImageUrl(data: string): boolean {
  return data.startsWith('http://') || data.startsWith('https://');
}

function getDataUrlMimeType(data: string): string | undefined {
  const match = data.match(/^data:([^;,]+)[;,]/);
  return match?.[1];
}

export async function downloadImageAsBase64(
  url: string,
  outerSignal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const response = await fetchWithAbort(url, {}, TIMEOUT_MS.IMAGE_DOWNLOAD, outerSignal);
  if (!response.ok) {
    throw new Error(`图片下载失败: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/png';
  return `data:${contentType};base64,${base64}`;
}

interface OpenRouterImageMessage {
  images?: Array<{
    image_url?: { url?: string };
    imageUrl?: { url?: string };
  }>;
}

function extractImageFromResponse(result: { choices?: Array<{ message?: OpenRouterImageMessage }> }): string {
  const message = result.choices?.[0]?.message;
  if (!message) {
    throw new Error('响应格式错误: 无 message');
  }
  const images = message.images;
  if (!images || images.length === 0) {
    throw new Error('未返回图片数据');
  }
  const imageUrl = images[0].image_url?.url || images[0].imageUrl?.url;
  if (!imageUrl) {
    throw new Error('图片 URL 格式错误');
  }
  return imageUrl;
}

async function callZhipuImageGeneration(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  outerSignal: AbortSignal,
): Promise<{ url: string }> {
  const sizeMap: Record<string, string> = {
    '1:1': '1024x1024',
    '16:9': '1344x768',
    '9:16': '768x1344',
    '4:3': '1152x864',
    '3:4': '864x1152',
  };
  const size = sizeMap[aspectRatio] || '1024x1024';

  const requestBody = {
    model: ZHIPU_IMAGE_MODELS.standard,
    prompt,
    size,
  };

  const response = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.zhipuOfficial}/images/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    TIMEOUT_MS.DIRECT_API,
    outerSignal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱图像生成 API 错误: ${response.status} - ${error}`);
  }

  const result = await response.json();
  if (!result.data || result.data.length === 0 || !result.data[0].url) {
    throw new Error('智谱图像生成: 未返回图片 URL');
  }
  return { url: result.data[0].url };
}

export async function generateImage(
  engine: ImageEngine,
  fluxModel: string,
  prompt: string,
  aspectRatio: string,
  outerSignal: AbortSignal = new AbortController().signal,
): Promise<GenerateResult> {
  const configService = getConfigService();
  const safePrompt = prompt.includes('不要出现任何文字') ? prompt : prompt + NO_TEXT_SUFFIX;

  if (engine === 'cogview') {
    const zhipuApiKey = getZhipuOfficialApiKey()!;
    const result = await callZhipuImageGeneration(zhipuApiKey, safePrompt, aspectRatio, outerSignal);
    return { imageData: result.url, actualModel: ZHIPU_IMAGE_MODELS.standard };
  }

  // engine === 'flux'
  const openrouterApiKey = configService.getApiKey('openrouter')!;
  const requestBody = {
    model: fluxModel,
    messages: [{ role: 'user', content: safePrompt }],
    modalities: ['image'],
    image_config: { aspect_ratio: aspectRatio },
  };

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
      body: JSON.stringify(requestBody),
    },
    TIMEOUT_MS.DIRECT_API,
    outerSignal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API 调用失败: ${error}`);
  }
  const result = await response.json();
  const imageData = extractImageFromResponse(result);
  return { imageData, actualModel: fluxModel };
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
        TIMEOUT_MS.PROMPT_EXPAND,
        outerSignal,
      );

      if (response.ok) {
        const result = await response.json();
        const msg = result.choices?.[0]?.message;
        const expanded = (msg?.content || msg?.reasoning_content || '').trim();
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
        TIMEOUT_MS.PROMPT_EXPAND,
        outerSignal,
      );
      if (response.ok) {
        const result = await response.json();
        const expanded = result.choices?.[0]?.message?.content?.trim();
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
    if (outputPath) {
      const resolvedPath = path.isAbsolute(outputPath)
        ? outputPath
        : path.join(ctx.workingDir, outputPath);

      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const imageBuffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(resolvedPath, imageBuffer);
      imagePath = resolvedPath;
      savedImageSizeBytes = imageBuffer.length;

      if (process.env.CODE_AGENT_CLI_MODE === 'true' && fs.existsSync(resolvedPath)) {
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
      output: imagePath ? `图片生成成功。Saved to: ${imagePath}` : '图片生成成功。',
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
