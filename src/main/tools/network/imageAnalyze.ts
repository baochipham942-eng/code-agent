// ============================================================================
// Image Analyze Tool - 图片分析与批量筛选
// 使用 Gemini 2.0 Flash 视觉模型，支持单图分析和批量筛选
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';
import { CLOUD_ENDPOINTS, MODEL_API_ENDPOINTS, ZHIPU_VISION_MODEL, MODEL_MAX_TOKENS } from '../../../shared/constants';

const logger = createLogger('ImageAnalyze');

// 配置
const CONFIG = {
  OPENROUTER_MODEL: 'google/gemini-2.0-flash-001',
  ZHIPU_MODEL: ZHIPU_VISION_MODEL, // 必须用 plus 版本，flash 不支持 base64
  ZHIPU_MAX_TOKENS: MODEL_MAX_TOKENS.VISION, // glm-4.6v 最大 8192
  MAX_PARALLEL: 10,
  TIMEOUT_MS: 30000,
  SUPPORTED_FORMATS: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'],
  MAX_IMAGE_SIZE_MB: 20,
};

// MIME 类型映射
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

interface ImageAnalyzeParams {
  // 单图模式
  path?: string;
  prompt?: string;

  // 批量模式
  paths?: string[];
  filter?: string;

  // 通用
  detail?: 'low' | 'high';
}

interface AnalysisResult {
  path: string;
  success: boolean;
  content?: string;
  matched?: boolean;
  error?: string;
}

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
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 通过云端代理调用模型 API
 */
async function callViaCloudProxy(body: unknown): Promise<Response> {
  return fetchWithTimeout(
    CLOUD_ENDPOINTS.modelProxy,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openrouter',
        endpoint: '/chat/completions',
        body,
      }),
    },
    CONFIG.TIMEOUT_MS
  );
}

/**
 * 直接调用 OpenRouter API
 */
async function callDirectOpenRouter(apiKey: string, body: unknown): Promise<Response> {
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
    CONFIG.TIMEOUT_MS
  );
}

/**
 * 调用智谱视觉模型 API
 */
async function callZhipuVision(
  apiKey: string,
  base64Image: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const requestBody = {
    model: CONFIG.ZHIPU_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: CONFIG.ZHIPU_MAX_TOKENS,
  };

  const response = await fetchWithTimeout(
    `${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    CONFIG.TIMEOUT_MS
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱视觉 API 错误: ${response.status} - ${error}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

/**
 * 调用视觉模型分析图片
 * 优先级：智谱 > OpenRouter > 云端代理
 */
async function analyzeImage(
  imagePath: string,
  prompt: string,
  detail: 'low' | 'high' = 'low'
): Promise<string> {
  // 读取图片
  const imageData = await fs.readFile(imagePath);
  const base64Image = imageData.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'image/jpeg';

  const configService = getConfigService();

  // 1. 优先尝试智谱视觉 API（glm-4.6v 支持 base64）
  const zhipuApiKey = configService.getApiKey('zhipu');
  if (zhipuApiKey) {
    try {
      logger.info('[图片分析] 使用智谱视觉模型 glm-4.6v');
      return await callZhipuVision(zhipuApiKey, base64Image, mimeType, prompt);
    } catch (error: any) {
      logger.warn('[图片分析] 智谱视觉 API 失败，尝试回退', { error: error.message });
    }
  }

  // 2. 尝试 OpenRouter 本地 API Key
  const openrouterApiKey = configService.getApiKey('openrouter');
  if (openrouterApiKey) {
    const requestBody = {
      model: CONFIG.OPENROUTER_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
                detail,
              },
            },
          ],
        },
      ],
      max_tokens: 1024,
    };

    try {
      logger.info('[图片分析] 使用 OpenRouter Gemini');
      const directResponse = await callDirectOpenRouter(openrouterApiKey, requestBody);
      if (directResponse.ok) {
        const result = await directResponse.json();
        return result.choices?.[0]?.message?.content || '';
      }
      logger.warn('[图片分析] OpenRouter 失败', { status: directResponse.status });
    } catch (error: any) {
      logger.warn('[图片分析] OpenRouter 错误', { error: error.message });
    }
  }

  // 3. 回退到云端代理
  const requestBody = {
    model: CONFIG.OPENROUTER_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Image}`,
              detail,
            },
          },
        ],
      },
    ],
    max_tokens: 1024,
  };

  try {
    logger.info('[图片分析] 使用云端代理');
    const cloudResponse = await callViaCloudProxy(requestBody);
    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      return result.choices?.[0]?.message?.content || '';
    }
    logger.warn('[图片分析] 云端代理失败', { status: cloudResponse.status });
  } catch (error: any) {
    logger.warn('[图片分析] 云端代理错误', { error: error.message });
  }

  throw new Error('所有视觉 API 均不可用。请配置智谱或 OpenRouter API Key。');
}

/**
 * 检查图片是否匹配筛选条件
 */
async function checkImageMatch(
  imagePath: string,
  filter: string,
  detail: 'low' | 'high'
): Promise<boolean> {
  const prompt = `判断这张图片是否符合以下条件：「${filter}」

请只回答 YES 或 NO，不要其他内容。`;

  const response = await analyzeImage(imagePath, prompt, detail);
  const answer = response.trim().toUpperCase();
  return answer.includes('YES');
}

/**
 * 展开 glob 模式获取文件列表
 */
async function expandPaths(
  patterns: string[],
  workingDir: string
): Promise<string[]> {
  const allPaths: string[] = [];

  for (const pattern of patterns) {
    // 如果是绝对路径或相对路径（非 glob），直接添加
    if (!pattern.includes('*') && !pattern.includes('?')) {
      const absPath = path.isAbsolute(pattern)
        ? pattern
        : path.join(workingDir, pattern);
      allPaths.push(absPath);
      continue;
    }

    // 展开 glob 模式
    const matches = await glob(pattern, {
      cwd: workingDir,
      absolute: true,
      nodir: true,
    });
    allPaths.push(...matches);
  }

  // 过滤只保留支持的图片格式
  return allPaths.filter((p) => {
    const ext = path.extname(p).toLowerCase();
    return CONFIG.SUPPORTED_FORMATS.includes(ext);
  });
}

/**
 * 并行处理图片（最大并行数限制）
 */
async function processInParallel<T>(
  items: T[],
  processor: (item: T) => Promise<AnalysisResult>,
  maxParallel: number,
  onProgress?: (completed: number, total: number) => void
): Promise<AnalysisResult[]> {
  const results: AnalysisResult[] = [];
  let completed = 0;

  // 分批处理
  for (let i = 0; i < items.length; i += maxParallel) {
    const batch = items.slice(i, i + maxParallel);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);

    completed += batch.length;
    onProgress?.(completed, items.length);
  }

  return results;
}

export const imageAnalyzeTool: Tool = {
  name: 'image_analyze',
  description: `图片内容分析工具 - 只分析描述，不修改图片。

**核心能力**：理解图片内容并返回文字描述或 JSON 数据，不会在图片上画任何标记。

**适用场景**：
- 描述图片内容、识别物体
- 提取图片中的文字（OCR，返回文本）
- 批量筛选符合条件的图片
- 回答关于图片的问题

**与 image_annotate 的区别**：
- image_analyze：只返回分析结果（文字/JSON），不修改图片
- image_annotate：在图片上画框标注，输出新图片文件

⚠️ 如果用户要求"框出"、"圈出"、"标记"、"画框"，应使用 image_annotate 而非本工具。

## 单图分析模式
参数：
- path: 图片路径（必填）
- prompt: 分析提示（可选，默认"描述图片内容"）
- detail: 图片精度 "low"(默认) | "high"

示例：
\`\`\`
image_analyze { "path": "photo.jpg", "prompt": "这张图片里有什么动物？" }
image_analyze { "path": "screenshot.png", "prompt": "提取图片中的所有文字" }
\`\`\`

## 批量筛选模式
参数：
- paths: 图片路径数组，支持 glob 模式（必填）
- filter: 筛选条件（必填）

示例：
\`\`\`
image_analyze { "paths": ["/Users/xxx/Photos/*.jpg"], "filter": "有猫的照片" }
\`\`\`

## 成本估算
- 100 张图片 ≈ $0.001（几乎免费）`,

  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '单张图片路径（单图模式）',
      },
      prompt: {
        type: 'string',
        description: '分析提示（单图模式，默认"描述图片内容"）',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '图片路径数组，支持 glob 模式（批量模式）',
      },
      filter: {
        type: 'string',
        description: '筛选条件（批量模式）',
      },
      detail: {
        type: 'string',
        enum: ['low', 'high'],
        description: '图片精度：low(默认,更便宜) | high(更准确)',
        default: 'low',
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      path: singlePath,
      prompt = '描述这张图片的内容',
      paths,
      filter,
      detail = 'low',
    } = params as unknown as ImageAnalyzeParams;

    const startTime = Date.now();

    try {
      // ==================== 单图分析模式 ====================
      if (singlePath) {
        const absPath = path.isAbsolute(singlePath)
          ? singlePath
          : path.join(context.workingDirectory, singlePath);

        // 检查文件存在
        try {
          await fs.access(absPath);
        } catch {
          return { success: false, error: `文件不存在: ${absPath}` };
        }

        // 检查格式
        const ext = path.extname(absPath).toLowerCase();
        if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
          return {
            success: false,
            error: `不支持的图片格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
          };
        }

        // 检查文件大小
        const stats = await fs.stat(absPath);
        const sizeMB = stats.size / (1024 * 1024);
        if (sizeMB > CONFIG.MAX_IMAGE_SIZE_MB) {
          return {
            success: false,
            error: `文件过大: ${sizeMB.toFixed(1)}MB，最大支持 ${CONFIG.MAX_IMAGE_SIZE_MB}MB`,
          };
        }

        context.emit?.('tool_output', {
          tool: 'image_analyze',
          message: `🔍 正在分析图片: ${path.basename(absPath)}`,
        });

        const content = await analyzeImage(absPath, prompt, detail);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        return {
          success: true,
          output: `📷 图片分析结果\n文件: ${path.basename(absPath)}\n耗时: ${elapsed}s\n\n${content}`,
          metadata: {
            path: absPath,
            elapsedSeconds: parseFloat(elapsed),
          },
        };
      }

      // ==================== 批量筛选模式 ====================
      if (paths && filter) {
        // 展开路径
        const imagePaths = await expandPaths(paths, context.workingDirectory);

        if (imagePaths.length === 0) {
          return {
            success: false,
            error: '未找到匹配的图片文件',
          };
        }

        context.emit?.('tool_output', {
          tool: 'image_analyze',
          message: `🔍 开始筛选 ${imagePaths.length} 张图片，条件: "${filter}"`,
        });

        // 并行处理
        const results = await processInParallel(
          imagePaths,
          async (imgPath) => {
            try {
              const matched = await checkImageMatch(imgPath, filter, detail);
              return { path: imgPath, success: true, matched };
            } catch (error: any) {
              logger.warn('Image analysis failed', { path: imgPath, error: error.message });
              return { path: imgPath, success: false, error: error.message };
            }
          },
          CONFIG.MAX_PARALLEL,
          (completed, total) => {
            context.emit?.('tool_output', {
              tool: 'image_analyze',
              message: `⏳ 进度: ${completed}/${total}`,
            });
          }
        );

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        // 统计结果
        const matched = results.filter((r) => r.success && r.matched);
        const failed = results.filter((r) => !r.success);

        let output = `✅ 筛选完成：找到 ${matched.length} 张匹配的图片\n\n`;

        if (matched.length > 0) {
          output += `匹配文件：\n`;
          matched.forEach((r, i) => {
            output += `${i + 1}. ${r.path}\n`;
          });
        }

        output += `\n处理统计：${imagePaths.length} 张 / 耗时 ${elapsed}s`;

        if (failed.length > 0) {
          output += ` / ${failed.length} 张处理失败`;
        }

        return {
          success: true,
          output,
          metadata: {
            total: imagePaths.length,
            matched: matched.length,
            failed: failed.length,
            matchedPaths: matched.map((r) => r.path),
            elapsedSeconds: parseFloat(elapsed),
          },
        };
      }

      // 参数错误
      return {
        success: false,
        error: '参数错误：单图模式需要 path，批量模式需要 paths + filter',
      };
    } catch (error: any) {
      logger.error('Image analyze failed', { error: error.message });
      return {
        success: false,
        error: `图片分析失败: ${error.message}`,
      };
    }
  },
};
