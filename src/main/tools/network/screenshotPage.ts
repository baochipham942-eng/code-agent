// ============================================================================
// Screenshot Page Tool - 网页截图工具（支持视觉分析）
// 使用 Electron webContents 或外部 API 截图
// 支持智谱 GLM-4.6V-Flash 视觉分析
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../../services/infra/logger';
import { getConfigService } from '../../services';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { formatFileSize } from './utils';

const logger = createLogger('ScreenshotPage');

// 视觉分析配置
const VISION_CONFIG = {
  ZHIPU_MODEL: ZHIPU_VISION_MODEL, // flash 不支持 base64，必须用 plus
  ZHIPU_API_URL: `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
  TIMEOUT_MS: 30000,
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

/**
 * 使用智谱视觉模型分析截图
 */
async function analyzeWithVision(
  imagePath: string,
  prompt: string
): Promise<string | null> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');

  if (!zhipuApiKey) {
    logger.info('[网页截图分析] 未配置智谱 API Key，跳过视觉分析');
    return null;
  }

  try {
    // 读取图片并转 base64
    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');

    const requestBody = {
      model: VISION_CONFIG.ZHIPU_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      max_tokens: 2048,
    };

    logger.info('[网页截图分析] 使用智谱视觉模型 GLM-4.6V-Flash');

    const response = await fetchWithTimeout(
      VISION_CONFIG.ZHIPU_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${zhipuApiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      VISION_CONFIG.TIMEOUT_MS
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn('[网页截图分析] API 调用失败', { status: response.status, error: errorText });
      return null;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    if (content) {
      logger.info('[网页截图分析] 分析完成', { contentLength: content.length });
    }

    return content || null;
  } catch (error: any) {
    logger.warn('[网页截图分析] 分析失败', { error: error.message });
    return null;
  }
}

interface ScreenshotPageParams {
  url: string;
  output_path?: string;
  width?: number;
  height?: number;
  full_page?: boolean;
  format?: 'png' | 'jpg';
  delay?: number;
  analyze?: boolean;
  prompt?: string;
}

/**
 * 使用 screenshotone.com API 截图（免费 API）
 */
async function screenshotViaApi(
  url: string,
  options: {
    width: number;
    height: number;
    fullPage: boolean;
    format: string;
  }
): Promise<Buffer> {
  // 使用 urlbox.io 的免费截图 API
  const apiUrl = new URL('https://api.screenshotone.com/take');
  apiUrl.searchParams.set('url', url);
  apiUrl.searchParams.set('viewport_width', options.width.toString());
  apiUrl.searchParams.set('viewport_height', options.height.toString());
  apiUrl.searchParams.set('full_page', options.fullPage.toString());
  apiUrl.searchParams.set('format', options.format);
  apiUrl.searchParams.set('access_key', 'free'); // 使用免费 key

  const response = await fetch(apiUrl.toString());

  if (!response.ok) {
    throw new Error(`截图 API 失败: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * 使用 microlink.io API 截图（备用）
 */
async function screenshotViaMicrolink(
  url: string,
  options: {
    width: number;
    height: number;
    fullPage: boolean;
    format: string;
  }
): Promise<Buffer> {
  const apiUrl = new URL('https://api.microlink.io');
  apiUrl.searchParams.set('url', url);
  apiUrl.searchParams.set('screenshot', 'true');
  apiUrl.searchParams.set('viewport.width', options.width.toString());
  apiUrl.searchParams.set('viewport.height', options.height.toString());
  apiUrl.searchParams.set('screenshot.fullPage', options.fullPage.toString());
  apiUrl.searchParams.set('screenshot.type', options.format === 'jpg' ? 'jpeg' : 'png');

  const response = await fetch(apiUrl.toString());
  const data = await response.json();

  if (!data.status || data.status !== 'success') {
    throw new Error(`Microlink API 失败: ${data.message || '未知错误'}`);
  }

  if (!data.data?.screenshot?.url) {
    throw new Error('未获取到截图 URL');
  }

  // 下载截图
  const imageResponse = await fetch(data.data.screenshot.url);
  return Buffer.from(await imageResponse.arrayBuffer());
}

/**
 * 使用 thum.io API 截图（备用）
 */
async function screenshotViaThumio(
  url: string,
  options: {
    width: number;
  }
): Promise<Buffer> {
  const encodedUrl = encodeURIComponent(url);
  const apiUrl = `https://image.thum.io/get/width/${options.width}/${encodedUrl}`;

  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error(`Thum.io API 失败: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export const screenshotPageTool: Tool = {
  name: 'screenshot_page',
  description: `截取网页屏幕截图，支持 AI 内容分析。

使用在线 API 服务截取网页，支持自定义视口大小和全页截图。
可选启用 AI 分析，理解网页内容、布局、文字等。

**使用示例：**
\`\`\`
screenshot_page { "url": "https://example.com" }
screenshot_page { "url": "https://github.com", "width": 1920, "height": 1080 }
screenshot_page { "url": "https://news.ycombinator.com", "full_page": true }
screenshot_page { "url": "https://example.com", "analyze": true }
screenshot_page { "url": "https://example.com", "analyze": true, "prompt": "这个网页是做什么的？" }
\`\`\`

**参数说明：**
- width: 视口宽度（默认: 1280）
- height: 视口高度（默认: 800）
- full_page: 截取完整页面（默认: false）
- format: 输出格式 png/jpg（默认: png）
- delay: 等待页面加载的毫秒数（默认: 0）
- analyze: 启用 AI 分析（默认: false）
- prompt: 自定义分析提示词`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要截图的网页 URL',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下自动生成）',
      },
      width: {
        type: 'number',
        description: '视口宽度（默认: 1280）',
        default: 1280,
      },
      height: {
        type: 'number',
        description: '视口高度（默认: 800）',
        default: 800,
      },
      full_page: {
        type: 'boolean',
        description: '是否截取完整页面（默认: false）',
        default: false,
      },
      format: {
        type: 'string',
        enum: ['png', 'jpg'],
        description: '输出格式（默认: png）',
        default: 'png',
      },
      delay: {
        type: 'number',
        description: '等待页面加载的毫秒数（默认: 0）',
        default: 0,
      },
      analyze: {
        type: 'boolean',
        description: '启用 AI 分析网页内容（默认: false）',
        default: false,
      },
      prompt: {
        type: 'string',
        description: '自定义分析提示词（默认: 分析网页内容和布局）',
      },
    },
    required: ['url'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      url,
      output_path,
      width = 1280,
      height = 800,
      full_page = false,
      format = 'png',
      delay = 0,
      analyze = false,
      prompt: analysisPrompt,
    } = params as unknown as ScreenshotPageParams;

    const defaultAnalysisPrompt = `请分析这个网页的内容，包括：
1. 网页的主要用途和类型
2. 主要的内容区域和布局
3. 关键的文字信息和链接
4. 如果有表单、按钮等交互元素，请描述其功能`;

    try {
      // 验证 URL
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          throw new Error('仅支持 http/https 协议');
        }
      } catch {
        return {
          success: false,
          error: `无效的 URL: ${url}`,
        };
      }

      context.emit?.('tool_output', {
        tool: 'screenshot_page',
        message: `📸 正在截图: ${parsedUrl.hostname}`,
      });

      const options = {
        width,
        height,
        fullPage: full_page,
        format,
      };

      let imageBuffer: Buffer | null = null;
      let usedApi = '';

      // 尝试多个 API
      const apis = [
        { name: 'Thum.io', fn: () => screenshotViaThumio(url, { width }) },
        { name: 'Microlink', fn: () => screenshotViaMicrolink(url, options) },
      ];

      for (const api of apis) {
        try {
          imageBuffer = await api.fn();
          usedApi = api.name;
          break;
        } catch (e) {
          logger.warn(`${api.name} failed`, { error: (e as Error).message });
        }
      }

      if (!imageBuffer) {
        return {
          success: false,
          error: '所有截图 API 都失败了，请稍后重试',
        };
      }

      // 确定输出路径
      const timestamp = Date.now();
      const hostname = parsedUrl.hostname.replace(/\./g, '_');
      const fileName = `screenshot_${hostname}_${timestamp}.${format}`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, fileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 保存文件
      fs.writeFileSync(finalPath, imageBuffer);
      const stats = fs.statSync(finalPath);

      logger.info('Screenshot captured', { url, path: finalPath, size: stats.size, api: usedApi });

      let output = `✅ 网页截图完成！

🌐 URL: ${url}
📐 尺寸: ${width}x${height}
📄 格式: ${format.toUpperCase()}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`;

      // 如果启用分析，进行视觉分析
      let analysis: string | null = null;
      if (analyze) {
        context.emit?.('tool_output', {
          tool: 'screenshot_page',
          message: '🔍 正在分析网页内容...',
        });

        analysis = await analyzeWithVision(finalPath, analysisPrompt || defaultAnalysisPrompt);
        if (analysis) {
          output += `\n\n📝 AI 分析结果:\n${analysis}`;
        }
      }

      return {
        success: true,
        output,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          url,
          width,
          height,
          fullPage: full_page,
          format,
          api: usedApi,
          analyzed: !!analysis,
          analysis,
          attachment: {
            id: `screenshot-${timestamp}`,
            type: 'file',
            category: 'image',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: `image/${format === 'jpg' ? 'jpeg' : 'png'}`,
          },
        },
      };
    } catch (error: any) {
      logger.error('Screenshot failed', { error: error.message });
      return {
        success: false,
        error: `网页截图失败: ${error.message}`,
      };
    }
  },
};
