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

// ============================================================================
// 视频提示词扩展系统
// 区分文生视频和图生视频两套策略
// ============================================================================

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
8. **直接输出优化后的提示词，不要解释**

## 镜头语言速查

- 推镜头：从远到近，聚焦细节
- 拉镜头：从近到远，展现全貌
- 摇镜头：固定位置左右/上下转动
- 跟镜头：跟随主体移动
- 环绕镜头：围绕主体 360° 旋转
- 升降镜头：垂直方向移动
- 一镜到底：连续无剪辑跟随

## 示例

输入：一只柯基在跑
输出：一只短腿柯基犬在阳光斑驳的草地上欢快地飞速奔跑，四条小短腿快速交替，蓬松的尾巴左右摇摆，耳朵随风向后飘动。跟镜头从侧面平移拍摄，背景草地和野花快速后退形成动态模糊。黄金时刻暖色光线，电影质感。

输入：一杯咖啡
输出：一杯热拿铁咖啡放在大理石桌面上，浓密的奶泡表面缓缓形成精致的拉花图案，轻柔的蒸汽螺旋上升消散。镜头从正上方俯拍缓缓推近至特写，侧光勾勒出杯沿金色光边。温暖色调，微距摄影质感。

输入：日落海边
输出：夕阳缓缓沉入海平面，天空从橙红渐变到深紫色，金色阳光在海面铺开一条闪烁的光路。海浪有节奏地拍打沙滩后缓慢退去，留下湿润的沙面反射余晖。镜头从低角度缓慢摇向天际线，丁达尔光线穿透云层。电影级宽银幕画面。`;

const IMAGE_TO_VIDEO_PROMPT = `你是专业的 AI 视频提示词工程师。用户提供了一张起始图片，你需要描述图片中的内容应该如何动起来。

## 核心原则（图生视频专用）

1. **不要重复描述图片中已有的静态内容**（模型已经能看到图片）
2. **聚焦三个方面**：主体要做什么动作 + 镜头怎么移动 + 背景怎么变化
3. **添加区分性特征**帮助模型定位主体（如"戴墨镜的女人"、"红色跑车"）
4. **程度副词明确运动强度**："猛烈"、"轻柔"、"缓慢"、"快速"
5. **正面描述**：CogVideoX 不支持否定提示词
6. **控制在 150 字以内**（图片已包含视觉信息，提示词更精简）
7. **直接输出优化后的提示词，不要解释**

## 提示词结构

主体区分特征 + 核心动作(含强度) + 镜头运动 + 背景变化 + 氛围变化

## 示例

输入：让她笑起来
输出：画面中的女人缓缓露出灿烂的笑容，眼角微微上扬，发丝被微风轻轻吹动。镜头缓慢推向面部特写，背景虚化程度加深，暖色光线逐渐增强。

输入：让车开起来
输出：红色跑车猛然启动向前飞速驶去，轮胎短暂打滑扬起一阵白烟，车身快速缩小。跟镜头从侧面跟随后逐渐拉远至全景，道路两旁的树木快速后退形成运动模糊。

输入：让这个场景动起来
输出：前景的树叶随风轻柔摇曳，远处的云层缓慢飘移变形。镜头从画面中心缓缓向右平移摇拍，光线随时间推移渐渐变暖，整体氛围从宁静过渡到温馨。`;

/**
 * 扩展视频 prompt，将简短描述转换为详细的视频生成提示词
 * @param imageUrl 如果提供了图片 URL，使用图生视频策略
 */
async function expandVideoPrompt(
  apiKey: string,
  shortPrompt: string,
  imageUrl?: string
): Promise<string> {
  const systemPrompt = imageUrl ? IMAGE_TO_VIDEO_PROMPT : TEXT_TO_VIDEO_PROMPT;

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
          max_tokens: 400,
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
        mode: imageUrl ? '图生视频' : '文生视频',
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

  // 扩展 prompt（区分文生视频和图生视频策略）
  onProgress?.('✨ 优化视频描述...');
  const expandedPrompt = await expandVideoPrompt(apiKey, params.prompt, params.image_url);

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
