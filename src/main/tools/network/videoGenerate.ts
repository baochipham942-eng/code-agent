// ============================================================================
// Video Generate Tool - AI 视频生成
// 优先使用智谱 CogVideoX-3，否则回退到 OpenRouter
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';
import { DEFAULT_MODELS } from '../../../shared/constants';

const logger = createLogger('VideoGenerate');

// 超时配置
const TIMEOUT_MS = {
  SUBMIT: 30000,      // 提交任务 30 秒
  POLL: 5000,         // 轮询间隔 5 秒
  MAX_WAIT: 300000,   // 最长等待 5 分钟
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

// 智谱视频生成模型
// 参考文档: https://bigmodel.cn/dev/api/videomodel/cogvideox
const ZHIPU_VIDEO_MODELS = {
  standard: 'cogvideox-2',        // CogVideoX 2.0 标准版（注意：不是 cogvideox-v2）
  flash: 'cogvideox-flash',       // CogVideoX Flash（快速版）
} as const;

// 支持的尺寸（官方支持：720x480, 1024x1024, 1280x960, 960x1280, 1920x1080, 1080x1920, 2048x1080, 3840x2160）
const VIDEO_SIZES = {
  '16:9': '1920x1080',    // 默认 16:9 使用 1080p
  '9:16': '1080x1920',    // 竖屏 1080p
  '1:1': '1024x1024',     // 正方形
  '4:3': '1280x960',      // 4:3 比例
  '3:4': '960x1280',      // 竖屏 4:3
} as const;

interface VideoGenerateParams {
  prompt: string;
  image_url?: string;           // 图生视频：起始图片 URL
  aspect_ratio?: '16:9' | '9:16' | '1:1';
  quality?: 'quality' | 'speed';
  duration?: 5 | 10;            // 视频时长（秒）
  fps?: 30 | 60;                // 帧率
  output_path?: string;
}

interface ZhipuVideoTaskResponse {
  id: string;
  model: string;
  task_status: 'PROCESSING' | 'SUCCESS' | 'FAIL';
  video_result?: Array<{
    url: string;
    cover_image_url: string;
  }>;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * 提交智谱视频生成任务
 */
async function submitZhipuVideoTask(
  apiKey: string,
  params: {
    prompt: string;
    imageUrl?: string;
    size: string;
    quality: string;
    duration: number;
    fps: number;
  }
): Promise<string> {
  const requestBody: Record<string, unknown> = {
    model: ZHIPU_VIDEO_MODELS.standard,
    prompt: params.prompt,
    quality: params.quality,
    size: params.size,
    duration: params.duration,
    fps: params.fps,
  };

  // 图生视频模式
  if (params.imageUrl) {
    requestBody.image_url = params.imageUrl;
  }

  logger.info('[智谱视频生成] 提交任务', {
    model: requestBody.model,
    size: params.size,
    duration: params.duration,
    hasImage: !!params.imageUrl,
  });

  const response = await fetchWithTimeout(
    'https://open.bigmodel.cn/api/paas/v4/videos/generations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    TIMEOUT_MS.SUBMIT
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱视频生成 API 错误: ${response.status} - ${error}`);
  }

  const result = await response.json();

  // 返回任务 ID
  if (!result.id) {
    throw new Error('智谱视频生成: 未返回任务 ID');
  }

  logger.info('[智谱视频生成] 任务已提交', { taskId: result.id });
  return result.id;
}

/**
 * 查询智谱视频生成任务状态
 */
async function queryZhipuVideoTask(
  apiKey: string,
  taskId: string
): Promise<ZhipuVideoTaskResponse> {
  const response = await fetchWithTimeout(
    `https://open.bigmodel.cn/api/paas/v4/async-result/${taskId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    TIMEOUT_MS.SUBMIT
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`查询任务状态失败: ${response.status} - ${error}`);
  }

  return response.json();
}

/**
 * 等待智谱视频生成完成
 */
async function waitForZhipuVideoCompletion(
  apiKey: string,
  taskId: string,
  onProgress?: (message: string) => void
): Promise<{ videoUrl: string; coverUrl: string }> {
  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < TIMEOUT_MS.MAX_WAIT) {
    pollCount++;
    const result = await queryZhipuVideoTask(apiKey, taskId);

    if (result.task_status === 'SUCCESS') {
      if (!result.video_result || result.video_result.length === 0) {
        throw new Error('视频生成成功但未返回视频 URL');
      }
      logger.info('[智谱视频生成] 任务完成', { taskId, pollCount });
      return {
        videoUrl: result.video_result[0].url,
        coverUrl: result.video_result[0].cover_image_url,
      };
    }

    if (result.task_status === 'FAIL') {
      throw new Error(
        `视频生成失败: ${result.error?.message || '未知错误'} (${result.error?.code || 'UNKNOWN'})`
      );
    }

    // 仍在处理中
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    onProgress?.(`⏳ 视频生成中... (${elapsed}秒)`);

    // 等待后继续轮询
    await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS.POLL));
  }

  throw new Error(`视频生成超时（${TIMEOUT_MS.MAX_WAIT / 1000}秒）`);
}

/**
 * 扩展视频 prompt，将简短描述转换为详细的视频生成提示词
 */
async function expandVideoPrompt(
  apiKey: string,
  shortPrompt: string
): Promise<string> {
  const systemPrompt = `你是一个专业的视频提示词优化师。将用户的简短描述扩展成适合 AI 视频生成的详细提示词。

要求：
1. 保持原意，但添加视觉细节（光线、色彩、氛围）
2. 描述动作和运动方式
3. 添加场景环境细节
4. 控制在 100 字以内
5. 直接输出优化后的提示词，不要解释

示例：
输入：一只柯基在跑
输出：一只可爱的柯基犬在阳光明媚的草地上欢快奔跑，毛发随风飘动，短腿快速交替，尾巴摇摆，背景是蓝天白云和绿色草坪`;

  try {
    const response = await fetchWithTimeout(
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
          max_tokens: 200,
        }),
      },
      10000
    );

    if (!response.ok) {
      logger.warn('[Prompt扩展] 失败，使用原始 prompt');
      return shortPrompt;
    }

    const result = await response.json();
    const expandedPrompt = result.choices?.[0]?.message?.content?.trim();

    if (expandedPrompt) {
      logger.info('[Prompt扩展] 成功', {
        original: shortPrompt.substring(0, 30),
        expanded: expandedPrompt.substring(0, 50)
      });
      return expandedPrompt;
    }

    return shortPrompt;
  } catch (error) {
    logger.warn('[Prompt扩展] 出错，使用原始 prompt', { error });
    return shortPrompt;
  }
}

/**
 * 使用智谱生成视频
 */
async function generateVideoWithZhipu(
  apiKey: string,
  params: VideoGenerateParams,
  onProgress?: (message: string) => void
): Promise<{ videoUrl: string; coverUrl: string }> {
  const aspectRatio = params.aspect_ratio || '16:9';
  const size = VIDEO_SIZES[aspectRatio] || VIDEO_SIZES['16:9'];

  // 扩展 prompt
  onProgress?.('✨ 优化视频描述...');
  const expandedPrompt = await expandVideoPrompt(apiKey, params.prompt);

  // 提交任务
  const taskId = await submitZhipuVideoTask(apiKey, {
    prompt: expandedPrompt,
    imageUrl: params.image_url,
    size,
    quality: params.quality || 'quality',
    duration: params.duration || 5,
    fps: params.fps || 30,
  });

  onProgress?.(`📝 任务已提交，ID: ${taskId.slice(0, 8)}...`);

  // 等待完成
  return waitForZhipuVideoCompletion(apiKey, taskId, onProgress);
}

/**
 * 下载视频到本地
 */
async function downloadVideo(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`下载视频失败: ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(buffer));
}

export const videoGenerateTool: Tool = {
  name: 'video_generate',
  description: `生成 AI 视频，可以根据文字描述或图片生成短视频。

支持横屏、竖屏、方形三种比例，时长 5 秒或 10 秒。生成需要 30-180 秒。`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '视频描述（支持中英文）',
      },
      image_url: {
        type: 'string',
        description: '起始图片 URL（用于图生视频）',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1'],
        description: '宽高比（默认: 16:9）',
        default: '16:9',
      },
      quality: {
        type: 'string',
        enum: ['quality', 'speed'],
        description: '质量模式（默认: quality）',
        default: 'quality',
      },
      duration: {
        type: 'number',
        description: '视频时长秒数，可选 5 或 10（默认: 5）',
        default: 5,
      },
      fps: {
        type: 'number',
        description: '帧率，可选 30 或 60（默认: 30）',
        default: 30,
      },
      output_path: {
        type: 'string',
        description: '保存路径（不填则返回 URL）',
      },
    },
    required: ['prompt'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const typedParams = params as unknown as VideoGenerateParams;
    const startTime = Date.now();

    try {
      const configService = getConfigService();
      const zhipuApiKey = configService.getApiKey('zhipu');

      if (!zhipuApiKey) {
        return {
          success: false,
          error: '视频生成需要配置智谱 API Key。请在设置中添加智谱 API Key。',
        };
      }

      logger.info('[视频生成] 开始', {
        prompt: typedParams.prompt.substring(0, 50),
        aspectRatio: typedParams.aspect_ratio,
        hasImage: !!typedParams.image_url,
      });

      context.emit?.('tool_output', {
        tool: 'video_generate',
        message: '🎬 正在生成视频（可能需要 30-180 秒）...',
      });

      // 生成视频
      const result = await generateVideoWithZhipu(
        zhipuApiKey,
        typedParams,
        (message) => {
          context.emit?.('tool_output', {
            tool: 'video_generate',
            message,
          });
        }
      );

      const generationTime = Date.now() - startTime;

      // 处理输出
      let videoPath: string | undefined;
      if (typedParams.output_path) {
        const resolvedPath = path.isAbsolute(typedParams.output_path)
          ? typedParams.output_path
          : path.join(context.workingDirectory, typedParams.output_path);

        // 确保目录存在
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // 下载视频
        context.emit?.('tool_output', {
          tool: 'video_generate',
          message: '📥 正在下载视频...',
        });

        await downloadVideo(result.videoUrl, resolvedPath);
        videoPath = resolvedPath;
        logger.info('[视频生成] 视频已保存', { path: videoPath });
      }

      const output = videoPath
        ? `视频生成成功，已保存到: ${videoPath}`
        : `视频生成成功。\n视频 URL: ${result.videoUrl}\n封面 URL: ${result.coverUrl}`;

      return {
        success: true,
        output,
        metadata: {
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          videoPath,
          prompt: typedParams.prompt,
          aspectRatio: typedParams.aspect_ratio || '16:9',
          duration: typedParams.duration || 5,
          fps: typedParams.fps || 30,
          generationTimeMs: generationTime,
        },
      };
    } catch (error: any) {
      logger.error('[视频生成] 失败', { error: error.message });
      return {
        success: false,
        error: `视频生成失败: ${error.message}`,
      };
    }
  },
};
