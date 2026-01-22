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

const logger = createLogger('ImageGenerate');

// 模型配置（2025-01 更新为 FLUX.2 系列）
const FLUX_MODELS = {
  pro: 'black-forest-labs/flux.2-pro', // 管理员专用，最高质量
  schnell: 'black-forest-labs/flux.2-klein-4b', // 普通用户，快速便宜
} as const;

// Prompt 扩展模型
const PROMPT_EXPAND_MODEL = 'deepseek/deepseek-chat';

// Prompt 扩展 System Prompt
const EXPAND_SYSTEM_PROMPT = `You are an expert image prompt engineer. Transform the user's brief description into a detailed, high-quality image generation prompt.

Rules:
1. Output in English (better model understanding)
2. Add visual details: lighting, colors, composition, style
3. Include technical terms: camera angle, depth of field, etc.
4. Keep under 200 words
5. Do not add NSFW content
6. Preserve the user's core intent

Output only the enhanced prompt, no explanation.`;

// 风格后缀映射
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
 * 获取云端 API URL
 */
function getCloudApiUrl(): string {
  const configService = getConfigService();
  const settings = configService.getSettings();
  return (
    process.env.CLOUD_API_URL ||
    settings.cloudApi?.url ||
    'https://code-agent-beta.vercel.app'
  );
}

/**
 * 通过云端代理调用模型 API
 */
async function callViaCloudProxy(
  provider: string,
  endpoint: string,
  body: unknown
): Promise<Response> {
  const cloudUrl = getCloudApiUrl();

  const response = await fetch(`${cloudUrl}/api/model-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider,
      endpoint,
      body,
    }),
  });

  return response;
}

/**
 * 直接调用 OpenRouter API
 */
async function callDirectOpenRouter(apiKey: string, body: unknown): Promise<Response> {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://code-agent.app',
      'X-Title': 'Code Agent',
    },
    body: JSON.stringify(body),
  });
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
 */
async function generateImage(
  model: string,
  prompt: string,
  aspectRatio: string
): Promise<string> {
  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: aspectRatio },
  };

  // 1. 优先尝试云端代理
  try {
    logger.info('Trying cloud proxy for image generation...');
    const cloudResponse = await callViaCloudProxy(
      'openrouter',
      '/chat/completions',
      requestBody
    );

    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      logger.info('Cloud proxy success');
      return extractImageFromResponse(result);
    }

    const errorText = await cloudResponse.text();
    logger.warn('Cloud proxy failed', { status: cloudResponse.status, error: errorText });
  } catch (error: any) {
    logger.warn('Cloud proxy error', { error: error.message });
  }

  // 2. 回退到本地 API Key
  logger.info('Falling back to local API key...');
  const configService = getConfigService();
  const apiKey = configService.getApiKey('openrouter');

  if (!apiKey) {
    throw new Error(
      'OpenRouter API Key 未配置，且云端代理不可用。请在设置中配置 OpenRouter API Key。'
    );
  }

  const directResponse = await callDirectOpenRouter(apiKey, requestBody);

  if (!directResponse.ok) {
    const error = await directResponse.text();
    throw new Error(`OpenRouter API 调用失败: ${error}`);
  }

  const result = await directResponse.json();
  return extractImageFromResponse(result);
}

/**
 * 调用 LLM 扩展 Prompt
 */
async function expandPromptWithLLM(prompt: string, style?: string): Promise<string> {
  const userPrompt = style ? `Style: ${style}\nDescription: ${prompt}` : prompt;

  const requestBody = {
    model: PROMPT_EXPAND_MODEL,
    messages: [
      { role: 'system', content: EXPAND_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 500,
  };

  // 优先云端代理
  try {
    const cloudResponse = await callViaCloudProxy(
      'openrouter',
      '/chat/completions',
      requestBody
    );

    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      return result.choices?.[0]?.message?.content?.trim() || prompt;
    }
  } catch (e) {
    logger.warn('Cloud proxy failed for prompt expansion');
  }

  // 回退本地
  const apiKey = getConfigService().getApiKey('openrouter');
  if (!apiKey) {
    logger.warn('No API key for prompt expansion, using original prompt');
    return prompt;
  }

  try {
    const response = await callDirectOpenRouter(apiKey, requestBody);
    if (response.ok) {
      const result = await response.json();
      return result.choices?.[0]?.message?.content?.trim() || prompt;
    }
  } catch (e) {
    logger.warn('Direct API failed for prompt expansion');
  }

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
