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
import { createFileArtifact, createVirtualArtifact } from '../../../tools/artifacts/artifactMeta';
import { buildMediaArtifactMetadata } from '../../../tools/artifacts/mediaArtifactMetadata';
import { imageGenerateSchema as schema } from './imageGenerate.schema';
import {
  determineImageEngine,
  generateImage,
  downloadImageAsBase64,
  isImageUrl,
  type ImageEngine,
} from '../../../services/media/imageGenerationService';
import { readChatCompletionText } from '../typedResponseGuards';
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

interface ImageGenerateParams {
  prompt: string;
  expand_prompt?: boolean;
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  output_path?: string;
  style?: 'photo' | 'illustration' | '3d' | 'anime';
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

function defaultImageOutputPath(workingDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  return path.join(workingDir, DEFAULT_IMAGE_ARTIFACT_DIR, `generated-${timestamp}.png`);
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
  const outputPath = params.output_path || defaultImageOutputPath(ctx.workingDir);
  const isDefaultOutputPath = !params.output_path;

  // 复述句里承诺过「出完存到 X」，失败收口要据实说 X 到底有没有落盘，故这里记账。
  let wroteFile = false;
  let briefed = false;

  // 走 tool_output_delta 而非 'tool_output'：后者不在 AgentEvent 联合类型里
  // （本文件原先靠 `as never` 强推），renderer 全仓无消费者，等于写给空气。
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
    const authService = getAuthService();
    const user = authService.getCurrentUser();
    const isAdmin = user?.isAdmin ?? false;
    const fluxModel = isAdmin ? FLUX_MODELS.pro : FLUX_MODELS.schnell;

    const engineLabel =
      engine === 'cogview'
        ? 'CogView-4 (智谱)'
        : `FLUX (${isAdmin ? 'Pro' : 'Schnell'})`;

    // 复述句在任何付费调用之前发出——包括 prompt 扩写那次文本调用，
    // 这样用户看到理解错了可以立刻打断，一分钱不花。
    emitLive(
      buildBriefing({
        prompt: params.prompt,
        aspectRatio,
        style,
        expandPrompt,
        engineLabel,
        outputPath,
      }),
    );
    briefed = true;

    // 复述句承诺过「会先扩写」。expandPromptWithLLM 在 key 失效/超时时是**静默**回退到
    // 原 prompt 的（只打一条 warn 日志），那样承诺就悄悄落空了。这里比对回退值，
    // 一旦落空就当场更正——说出去的话和实际做的事不允许无声分叉。
    const unexpandedPrompt = style ? addStyleSuffix(params.prompt, style) : params.prompt;
    let finalPrompt = params.prompt;
    if (expandPrompt) {
      finalPrompt = await expandPromptWithLLM(params.prompt, engine, ctx.abortSignal, ctx.logger, style);
      if (finalPrompt === unexpandedPrompt) {
        emitLive('更正：扩写没成功（模型没返回可用结果），改为把你的原话原样送去出图。');
      }
    } else if (style) {
      finalPrompt = unexpandedPrompt;
    }

    const { imageData: rawImageData, actualModel } = await generateImage(
      engine,
      fluxModel,
      finalPrompt,
      aspectRatio,
      ctx.abortSignal,
    );

    let imageBase64: string;
    if (isImageUrl(rawImageData)) {
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
    let dimensions: { width: number; height: number } | undefined;
    if (!isImageUrl(imageBase64)) {
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
      wroteFile = true;
      savedImageSizeBytes = imageBuffer.length;
      // 验收句要拿实际像素跟所要比例对数，所以量的是落盘字节而不是请求参数。
      dimensions = parsePngDimensions(imageBuffer);

      if (process.env.CODE_AGENT_CLI_MODE === 'true' && fs.existsSync(resolvedPath)) {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        safeExecDetached(openCmd, [resolvedPath], (err: Error) => {
          ctx.logger.warn('image_generate auto-open failed', { error: err.message });
        });
      }
    }

    const generationTime = Date.now() - startTime;
    const mediaArtifactMetadata = buildMediaArtifactMetadata(ctx, {
      kind: 'generated-image',
      operation: 'generate',
      sourcePrompt: params.prompt,
      fallbackStrategy: imagePath ? 'file-artifact' : 'embedded-base64-artifact',
    });

    onProgress?.({ stage: 'completing', percent: 100 });

    // 验收句同时是工具 output：用户在转录里看到的、模型读回去的是同一句具体陈述，
    // 模型没有「已完成」这类可润色的状态词可抄。
    const verdict = buildVerdict({
      aspectRatio,
      actualModel,
      engineLabel,
      dimensions,
      generationTimeMs: generationTime,
      imagePath,
      sizeBytes: savedImageSizeBytes,
    });
    emitLive(verdict);

    return {
      ok: true,
      output: verdict,
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
              autoPersisted: isDefaultOutputPath,
              ...mediaArtifactMetadata,
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
              ...mediaArtifactMetadata,
            },
          }),
        model: actualModel,
        engine,
        originalPrompt: params.prompt,
        expandedPrompt: expandPrompt ? finalPrompt : undefined,
        imagePath,
        outputPath: imagePath,
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
    // 失败收口：复述句已经说出去了，这里必须回指它，并据实说落盘到底发生了没有——
    // 不能让用户停在「我这就去出一张 9:16」然后没有下文。
    if (!briefed) {
      return { ok: false, error: `图片生成失败: ${message}` };
    }
    const landed = wroteFile
      ? `图片已落盘到 ${outputPath}，但后续步骤失败`
      : `${outputPath} 没有生成，磁盘上没有新图`;
    return {
      ok: false,
      error: `上面说要出的那张「${aspectRatioLabel(aspectRatio)}：${params.prompt}」没有出成：${message}。${landed}。`,
    };
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
