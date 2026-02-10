// ============================================================================
// Image Generate Tool - AI 图片生成
// 管理员用 FLUX Pro，普通用户用 FLUX Schnell
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { getAuthService } from '../../services/auth/authService';
import { createLogger } from '../../services/infra/logger';
import { CLOUD_ENDPOINTS, MODEL_API_ENDPOINTS, DEFAULT_MODELS } from '../../../shared/constants';

const logger = createLogger('ImageGenerate');

// 超时配置
const TIMEOUT_MS = {
  CLOUD_PROXY: 60000, // 云端代理 60 秒
  DIRECT_API: 90000, // 直接 API 90 秒（图片生成较慢）
  PROMPT_EXPAND: 30000, // Prompt 扩展 30 秒
};

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 模型配置（2025-01 更新为 FLUX.2 系列）
const FLUX_MODELS = {
  pro: 'black-forest-labs/flux.2-pro', // 管理员专用，最高质量
  schnell: 'black-forest-labs/flux.2-klein-4b', // 普通用户，快速便宜
} as const;

// Prompt 扩展模型（OpenRouter fallback 用）
const PROMPT_EXPAND_MODEL = 'deepseek/deepseek-chat';

// ============================================================================
// CogView4 图片提示词扩展系统
// 基于智谱官方建议：用 GLM 扩写丰富描述配合 CogView4 效果最佳
// ============================================================================

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
8. **控制在 200 字以内**
9. **直接输出优化后的提示词，不要解释**

## 风格指导

如果用户指定了风格，融入提示词中：
- **摄影(photo)**：强调真实质感、光影层次、景深、镜头参数，如"专业摄影，85mm f/1.4 浅景深"
- **插画(illustration)**：强调笔触、色彩饱和、艺术感，如"精细数字插画，丰富色彩层次"
- **3D渲染(3d)**：强调材质、光线追踪、体积感，如"Octane 渲染，真实材质质感，体积光"
- **动漫(anime)**：强调线条、大眼、色彩鲜明，如"日系动漫风格，精细线条，明亮配色"

## 示例

输入：一只猫
输出：一只毛茸茸的橘色短毛猫蹲坐在铺着亚麻桌布的木桌上，翠绿色的眼睛好奇地直视镜头，胡须微微前倾，耳朵竖起。柔和的侧窗自然光照亮猫咪半侧脸庞，毛发上泛起金色光泽，背景是温馨的厨房场景虚化成奶油色光斑。85mm f/1.4 浅景深，暖色调，治愈系氛围。

输入：古风美女
输出：一位身着淡青色交领齐胸襦裙的古风女子，乌黑长发挽成流云髻，发间点缀珍珠步摇，手执一柄团扇半遮面庞，露出含笑的杏眼。她站在盛开的桃花树下，花瓣纷纷飘落在肩头和裙摆上。逆光拍摄，阳光穿过花枝形成斑驳光影，丁达尔效应，整体色调粉白相间。工笔画质感，精致细腻。

输入：赛博朋克城市
输出：雨夜中的赛博朋克城市街道，高耸的摩天大楼上密布霓虹广告牌，紫色和青色的灯光倒映在湿漉漉的柏油路面上。街边蒸汽从下水道口袅袅升起，一辆飞行汽车从楼宇间低空掠过留下光带轨迹。低角度仰拍，35mm 广角镜头产生强烈透视纵深感，画面暗部浓郁亮部霓虹溢出。电影感调色，颗粒质感。

输入：产品展示：一瓶香水
输出：一瓶切割面精致的琥珀色香水矗立在黑色大理石台面上，瓶身棱角折射出彩虹般的光谱色散。金色瓶盖上刻有精细花纹，瓶身周围散落几片干燥的玫瑰花瓣和一小截香草荚。单点侧光从左上方打入，在台面上投射出长长的光影，背景渐变为深灰色。微距摄影，焦点锐利在瓶身标签上，前后景虚化，高级广告质感。`;

// ============================================================================
// FLUX.2 图片提示词扩展系统
// FLUX 偏好自然语言英文描述，30-80 词甜点，不支持否定提示词和权重语法
// ============================================================================

const FLUX2_EXPAND_PROMPT = `You are an expert image prompt engineer optimizing prompts for FLUX.2 image generation.

## Prompt Structure

Subject (with appearance) + Environment + Lighting + Composition/Camera + Style/Medium + Mood

## Core Rules

1. **English output**: FLUX.2 performs best with English natural language
2. **Natural language over keywords**: Write descriptive prose, NOT comma-separated tags. "A woman standing in a sunlit garden" beats "woman, garden, sunlight, standing"
3. **No weight syntax**: Do NOT use (element:1.3) or [[brackets]] — FLUX ignores them
4. **No negative prompts**: Describe what you WANT, not what to avoid. "sharp focus" instead of "no blur"
5. **Camera/lens references boost quality**: "Shot on Sony A7IV, 85mm f/1.2" triggers photographic training data
6. **Specific over generic**: "weathered oak table" not "table", "amber afternoon light" not "good lighting"
7. **30-80 words sweet spot**: Too short lacks control, too long dilutes attention
8. **Output only the enhanced prompt, no explanation**

## Style Integration

If user specifies a style, weave it naturally into the description:
- **photo**: Emphasize camera model, lens, film stock. "Shot on Canon EOS R5, 85mm f/1.2L, Kodak Portra 400 color palette"
- **illustration**: Emphasize medium and artist influence. "Digital illustration with rich watercolor textures, detailed linework"
- **3d**: Emphasize render engine and materials. "Octane render, subsurface scattering, volumetric lighting, PBR materials"
- **anime**: Emphasize anime studio quality. "Studio Ghibli-inspired anime artwork, cel-shaded, vibrant palette"

## Examples

Input: a cat
Output: A fluffy orange tabby cat perched on a sunlit windowsill, emerald eyes gazing directly at the viewer with quiet curiosity. Soft morning light streams through sheer curtains, casting warm highlights across its fur and delicate whiskers. Shot with an 85mm f/1.4 lens, shallow depth of field blurring a cozy apartment interior behind. Warm tones, intimate atmosphere.

Input: cyberpunk city
Output: A rain-soaked cyberpunk street at night, towering skyscrapers draped in holographic advertisements casting neon purple and teal reflections across wet asphalt. Steam rises from a manhole cover as a lone figure in a dark trench coat walks toward the camera. Low angle shot with a 24mm wide-angle lens creating dramatic perspective. Cinematic color grading, film grain, moody atmosphere.

Input: product shot of a perfume bottle
Output: An elegant crystal perfume bottle standing on a black marble surface, faceted glass catching and refracting a single key light into rainbow prismatic flares. Scattered dried rose petals and a vanilla pod beside the base. Dramatic side lighting from upper left creating long shadows, gradient background fading to charcoal. Macro photography, tack-sharp focus on the label, creamy bokeh fore and aft. High-end advertising aesthetic.`;

// 风格后缀映射（简单模式、不走 LLM 扩写时使用）
const STYLE_SUFFIXES: Record<string, string> = {
  photo: ', photorealistic, high resolution, professional photography, sharp focus',
  illustration: ', digital illustration, detailed artwork, vibrant colors, artistic',
  '3d': ', 3D render, octane render, realistic lighting, detailed textures, volumetric',
  anime: ', anime style, detailed anime artwork, vibrant colors, studio quality',
};

interface ImageGenerateParams {
  prompt: string;
  expand_prompt?: boolean;
  aspect_ratio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  output_path?: string;
  style?: 'photo' | 'illustration' | '3d' | 'anime';
}

/**
 * 通过云端代理调用模型 API（带超时）
 */
async function callViaCloudProxy(
  provider: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number = TIMEOUT_MS.CLOUD_PROXY
): Promise<Response> {
  const response = await fetchWithTimeout(
    CLOUD_ENDPOINTS.modelProxy,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider,
        endpoint,
        body,
      }),
    },
    timeoutMs
  );

  return response;
}

/**
 * 直接调用 OpenRouter API（带超时）
 */
async function callDirectOpenRouter(
  apiKey: string,
  body: unknown,
  timeoutMs: number = TIMEOUT_MS.DIRECT_API
): Promise<Response> {
  return fetchWithTimeout(
    `${MODEL_API_ENDPOINTS.openrouter}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://code-agent.app',
        'X-Title': 'Code Agent',
      },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
}

// 智谱图像生成模型
const ZHIPU_IMAGE_MODELS = {
  standard: 'cogview-4',           // 标准模型
  fast: 'cogview-3-flash',         // 快速模型
  latest: 'cogview-4-250304',      // 最新版本
} as const;

/**
 * 调用智谱图像生成 API
 * 端点: https://open.bigmodel.cn/api/paas/v4/images/generations
 */
async function callZhipuImageGeneration(
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  timeoutMs: number = TIMEOUT_MS.DIRECT_API
): Promise<{ url: string }> {
  // 将 aspect ratio 转换为智谱支持的 size 格式
  const sizeMap: Record<string, string> = {
    '1:1': '1024x1024',
    '16:9': '1440x720',
    '9:16': '720x1440',
    '4:3': '1152x864',
    '3:4': '864x1152',
  };
  const size = sizeMap[aspectRatio] || '1024x1024';

  const requestBody = {
    model: ZHIPU_IMAGE_MODELS.standard,
    prompt,
    size,
  };

  logger.info(`[智谱图像生成] 使用模型: ${requestBody.model}, 尺寸: ${size}`);

  const response = await fetchWithTimeout(
    `${MODEL_API_ENDPOINTS.zhipu}/images/generations`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    timeoutMs
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱图像生成 API 错误: ${response.status} - ${error}`);
  }

  const result = await response.json();

  // 智谱返回格式: { data: [{ url: "..." }] }
  if (!result.data || result.data.length === 0 || !result.data[0].url) {
    throw new Error('智谱图像生成: 未返回图片 URL');
  }

  logger.info('[智谱图像生成] 成功生成图片');
  return { url: result.data[0].url };
}

/**
 * 从响应中提取图片数据
 */
function extractImageFromResponse(result: any): string {
  const message = result.choices?.[0]?.message;
  if (!message) {
    throw new Error('响应格式错误: 无 message');
  }

  const images = message.images;
  if (!images || images.length === 0) {
    throw new Error('未返回图片数据');
  }

  // OpenRouter 返回格式可能有两种
  const imageUrl = images[0].image_url?.url || images[0].imageUrl?.url;
  if (!imageUrl) {
    throw new Error('图片 URL 格式错误');
  }

  return imageUrl;
}

/**
 * 生成图片
 *
 * 策略（优先级从高到低）：
 * 1. 智谱 API Key -> 使用 CogView-4（国内直连，快速稳定）
 * 2. OpenRouter API Key -> 使用 FLUX（需 30-90 秒，避免云端代理超时）
 * 3. 云端代理 -> 可能因 Vercel 60 秒超时而失败
 */
async function generateImage(
  model: string,
  prompt: string,
  aspectRatio: string
): Promise<string> {
  const configService = getConfigService();

  // 优先级 1: 智谱 API Key -> 使用 CogView-4
  const zhipuApiKey = configService.getApiKey('zhipu');
  if (zhipuApiKey) {
    logger.info('[图像生成] 检测到智谱 API Key，使用 CogView-4 生成图片');
    try {
      const result = await callZhipuImageGeneration(zhipuApiKey, prompt, aspectRatio, TIMEOUT_MS.DIRECT_API);
      return result.url;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`智谱图像生成超时（${TIMEOUT_MS.DIRECT_API / 1000}秒），请稍后重试。`);
      }
      logger.warn('[图像生成] 智谱 API 失败，尝试回退到 OpenRouter', { error: error.message });
      // 继续尝试 OpenRouter
    }
  }

  // 优先级 2: OpenRouter API Key -> 使用 FLUX
  const openrouterApiKey = configService.getApiKey('openrouter');
  if (openrouterApiKey) {
    logger.info('[图像生成] 使用 OpenRouter FLUX 生成图片');

    const requestBody = {
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image', 'text'],
      image_config: { aspect_ratio: aspectRatio },
    };

    try {
      const directResponse = await callDirectOpenRouter(openrouterApiKey, requestBody, TIMEOUT_MS.DIRECT_API);

      if (!directResponse.ok) {
        const error = await directResponse.text();
        throw new Error(`OpenRouter API 调用失败: ${error}`);
      }

      const result = await directResponse.json();
      return extractImageFromResponse(result);
    } catch (error: any) {
      // 处理超时错误，给出友好提示
      if (error.name === 'AbortError') {
        throw new Error(
          `图片生成超时（${TIMEOUT_MS.DIRECT_API / 1000}秒）。FLUX 模型可能繁忙，请稍后重试。`
        );
      }
      throw error;
    }
  }

  // 优先级 3: 云端代理（可能会因 Vercel 超时而失败）
  logger.info('[图像生成] 无本地 API Key，尝试云端代理...');
  logger.warn('[图像生成] 云端代理可能因 Vercel 60s 限制而超时');

  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: aspectRatio },
  };

  try {
    const cloudResponse = await callViaCloudProxy(
      'openrouter',
      '/chat/completions',
      requestBody,
      TIMEOUT_MS.CLOUD_PROXY
    );

    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      logger.info('Cloud proxy success');
      return extractImageFromResponse(result);
    }

    const errorText = await cloudResponse.text();
    logger.warn('Cloud proxy failed', { status: cloudResponse.status, error: errorText });
    throw new Error(
      `云端代理失败: ${errorText}\n\n` +
      `建议：在设置中配置 OpenRouter API Key，以避免云端代理的超时限制。`
    );
  } catch (error: any) {
    // 处理超时错误
    if (error.name === 'AbortError') {
      throw new Error(
        `云端代理超时（${TIMEOUT_MS.CLOUD_PROXY / 1000}秒）。\n\n` +
        `FLUX 模型生成图片需要 30-90 秒，超过了云端代理的时间限制。\n` +
        `解决方案：在设置中配置 OpenRouter API Key，直接调用 API。`
      );
    }
    throw error;
  }
}

/**
 * 调用 LLM 扩展 Prompt
 *
 * 根据实际生图路径选择不同的扩写策略：
 * - 智谱 API Key 存在 → CogView4 策略（中文丰富描述，GLM 扩写）
 * - 走 OpenRouter/FLUX → FLUX.2 策略（英文自然语言，30-80 词）
 */
async function expandPromptWithLLM(prompt: string, style?: string): Promise<string> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');

  // 智谱 API Key 存在 → 生图走 CogView4 → 用 CogView4 策略扩写
  if (zhipuApiKey) {
    const userPrompt = style ? `风格: ${style}\n描述: ${prompt}` : prompt;
    try {
      const response = await fetchWithTimeout(
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
            max_tokens: 500,
          }),
        },
        10000
      );

      if (response.ok) {
        const result = await response.json();
        const expanded = result.choices?.[0]?.message?.content?.trim();
        if (expanded) {
          logger.info('[Prompt扩展] CogView4 策略 (智谱 GLM)', {
            original: prompt.substring(0, 30),
            expanded: expanded.substring(0, 50),
          });
          return expanded;
        }
      }
    } catch (e: any) {
      logger.warn('[Prompt扩展] 智谱 GLM 失败，尝试 OpenRouter fallback', { error: e.message });
    }
  }

  // 无智谱 API Key → 生图走 FLUX → 用 FLUX.2 策略扩写
  const userPrompt = style ? `Style: ${style}\nDescription: ${prompt}` : prompt;
  const fluxRequestBody = {
    model: PROMPT_EXPAND_MODEL,
    messages: [
      { role: 'system', content: FLUX2_EXPAND_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 500,
  };

  // 云端代理
  try {
    const cloudResponse = await callViaCloudProxy(
      'openrouter',
      '/chat/completions',
      fluxRequestBody,
      TIMEOUT_MS.PROMPT_EXPAND
    );

    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      const expanded = result.choices?.[0]?.message?.content?.trim();
      if (expanded) {
        logger.info('[Prompt扩展] FLUX.2 策略 (云端代理)');
        return expanded;
      }
    }
  } catch (e: any) {
    logger.warn('[Prompt扩展] 云端代理失败');
  }

  // 直连 OpenRouter
  const openrouterApiKey = configService.getApiKey('openrouter');
  if (openrouterApiKey) {
    try {
      const response = await callDirectOpenRouter(openrouterApiKey, fluxRequestBody, TIMEOUT_MS.PROMPT_EXPAND);
      if (response.ok) {
        const result = await response.json();
        const expanded = result.choices?.[0]?.message?.content?.trim();
        if (expanded) {
          logger.info('[Prompt扩展] FLUX.2 策略 (OpenRouter 直连)');
          return expanded;
        }
      }
    } catch (e: any) {
      logger.warn('[Prompt扩展] OpenRouter 直连失败');
    }
  }

  logger.warn('[Prompt扩展] 所有方式失败，使用原始 prompt');
  return prompt;
}

/**
 * 添加风格后缀
 */
function addStyleSuffix(prompt: string, style: string): string {
  return prompt + (STYLE_SUFFIXES[style] || '');
}

export const imageGenerateTool: Tool = {
  name: 'image_generate',
  description: `生成 AI 图片。
- 管理员用户使用 FLUX Pro（最高质量，约 $0.04/张）
- 普通用户使用 FLUX Schnell（快速免费）
- 支持 prompt 自动扩展优化

参数：
- prompt: 图片描述（支持中英文）
- expand_prompt: 是否使用 LLM 扩展优化 prompt（默认 false）
- aspect_ratio: 宽高比 "1:1" | "16:9" | "9:16" | "4:3" | "3:4"
- output_path: 保存路径（不填则返回 base64）
- style: 风格 "photo" | "illustration" | "3d" | "anime"

示例：
\`\`\`
image_generate { "prompt": "sunset over mountains" }
image_generate { "prompt": "一只猫", "expand_prompt": true, "aspect_ratio": "16:9" }
image_generate { "prompt": "产品展示图", "output_path": "./product.png", "style": "photo" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '图片描述（支持中英文）',
      },
      expand_prompt: {
        type: 'boolean',
        description: '是否使用 LLM 扩展 prompt（默认: false）',
        default: false,
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: '宽高比（默认: 1:1）',
        default: '1:1',
      },
      output_path: {
        type: 'string',
        description: '保存路径（不填则返回 base64）',
      },
      style: {
        type: 'string',
        enum: ['photo', 'illustration', '3d', 'anime'],
        description: '风格提示',
      },
    },
    required: ['prompt'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      prompt,
      expand_prompt = false,
      aspect_ratio = '1:1',
      output_path,
      style,
    } = params as unknown as ImageGenerateParams;

    const startTime = Date.now();

    try {
      // 1. 获取用户身份，选择模型
      const authService = getAuthService();
      const user = authService.getCurrentUser();
      const isAdmin = user?.isAdmin ?? false;
      const model = isAdmin ? FLUX_MODELS.pro : FLUX_MODELS.schnell;

      logger.info('Image generation started', {
        isAdmin,
        model,
        prompt: prompt.substring(0, 50),
      });

      context.emit?.('tool_output', {
        tool: 'image_generate',
        message: `🎨 使用模型: ${isAdmin ? 'FLUX Pro (管理员)' : 'FLUX Schnell'}`,
      });

      // 2. Prompt 扩展（可选）
      let finalPrompt = prompt;
      if (expand_prompt) {
        context.emit?.('tool_output', {
          tool: 'image_generate',
          message: '✨ 正在扩展优化 prompt...',
        });
        finalPrompt = await expandPromptWithLLM(prompt, style);
        logger.info('Prompt expanded', {
          original: prompt.substring(0, 50),
          expanded: finalPrompt.substring(0, 100),
        });
      } else if (style) {
        // 简单添加风格后缀
        finalPrompt = addStyleSuffix(prompt, style);
      }

      // 3. 调用 OpenRouter 生成图片
      context.emit?.('tool_output', {
        tool: 'image_generate',
        message: '🖼️ 正在生成图片（可能需要 10-30 秒）...',
      });

      const imageData = await generateImage(model, finalPrompt, aspect_ratio);

      // 4. 处理输出
      let imagePath: string | undefined;
      if (output_path) {
        const resolvedPath = path.isAbsolute(output_path)
          ? output_path
          : path.join(context.workingDirectory, output_path);

        // 确保目录存在
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // 保存图片（移除 data URL 前缀）
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(resolvedPath, Buffer.from(base64Data, 'base64'));
        imagePath = resolvedPath;

        logger.info('Image saved', { path: imagePath });
      }

      const generationTime = Date.now() - startTime;

      // 简化输出信息 - 图片会在 UI 中直接展示，无需在文本中重复路径
      // AI 模型只需知道生成成功即可，用户可以在 UI 中查看和操作图片
      const output = '图片生成成功。';

      return {
        success: true,
        output,
        metadata: {
          model,
          originalPrompt: prompt,
          expandedPrompt: expand_prompt ? finalPrompt : undefined,
          imagePath,
          imageBase64: imagePath ? undefined : imageData,
          aspectRatio: aspect_ratio,
          generationTimeMs: generationTime,
          isAdmin,
        },
      };
    } catch (error: any) {
      logger.error('Image generation failed', { error: error.message });
      return {
        success: false,
        error: `图片生成失败: ${error.message}`,
      };
    }
  },
};
