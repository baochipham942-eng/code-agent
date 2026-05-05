// ============================================================================
// screenshot_page (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy ScreenshotPageTool 迁移到 native：通过外部 HTTP API（Thum.io /
// Microlink）截图，可选用智谱视觉模型分析。**注意**：legacy 实现并不使用
// puppeteer，全部走 stateless HTTP API，所以没有 shared session vs per-call
// 的取舍 —— 每次截图都是独立 HTTP 请求，自然 race-and-abandon。
//
// abort signal 走 race-and-abandon：fetch AbortController 与 ctx.abortSignal
// 联动；多 API fallback 串行执行，aborted 后立即停止链路。
//
// 行为保真：legacy 中文文案、emoji（📸 🌐 📐 📦 🔍 📝）、metadata.attachment
// 形状（id 前缀 screenshot-、category=image）1:1 复刻。
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
import { getConfigService } from '../../../services';
import { ZHIPU_VISION_MODEL, MODEL_API_ENDPOINTS } from '../../../../shared/constants';
import { formatFileSize } from '../../utils/fileSize';
import { screenshotPageSchema as schema } from './screenshotPage.schema';

const VISION_CONFIG = {
  ZHIPU_MODEL: ZHIPU_VISION_MODEL,
  ZHIPU_API_URL: `${MODEL_API_ENDPOINTS.zhipu}/chat/completions`,
  TIMEOUT_MS: 30000,
};

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

const SHOT_TIMEOUT_MS = 60000;

async function screenshotViaThumio(
  url: string,
  width: number,
  outerSignal: AbortSignal,
): Promise<Buffer> {
  const encodedUrl = encodeURIComponent(url);
  const apiUrl = `https://image.thum.io/get/width/${width}/${encodedUrl}`;
  const response = await fetchWithAbort(apiUrl, {}, SHOT_TIMEOUT_MS, outerSignal);
  if (!response.ok) {
    throw new Error(`Thum.io API 失败: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function screenshotViaMicrolink(
  url: string,
  options: { width: number; height: number; fullPage: boolean; format: string },
  outerSignal: AbortSignal,
): Promise<Buffer> {
  const apiUrl = new URL('https://api.microlink.io');
  apiUrl.searchParams.set('url', url);
  apiUrl.searchParams.set('screenshot', 'true');
  apiUrl.searchParams.set('viewport.width', options.width.toString());
  apiUrl.searchParams.set('viewport.height', options.height.toString());
  apiUrl.searchParams.set('screenshot.fullPage', options.fullPage.toString());
  apiUrl.searchParams.set('screenshot.type', options.format === 'jpg' ? 'jpeg' : 'png');

  const response = await fetchWithAbort(apiUrl.toString(), {}, SHOT_TIMEOUT_MS, outerSignal);
  const data = await response.json();

  if (!data.status || data.status !== 'success') {
    throw new Error(`Microlink API 失败: ${data.message || '未知错误'}`);
  }
  if (!data.data?.screenshot?.url) {
    throw new Error('未获取到截图 URL');
  }

  const imageResponse = await fetchWithAbort(
    data.data.screenshot.url,
    {},
    SHOT_TIMEOUT_MS,
    outerSignal,
  );
  return Buffer.from(await imageResponse.arrayBuffer());
}

async function analyzeWithVision(
  imagePath: string,
  prompt: string,
  outerSignal: AbortSignal,
  logger: ToolContext['logger'],
): Promise<string | null> {
  const configService = getConfigService();
  const zhipuApiKey = configService.getApiKey('zhipu');
  if (!zhipuApiKey) {
    logger.debug('screenshot_page vision skipped: no zhipu api key');
    return null;
  }

  try {
    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');
    const requestBody = {
      model: VISION_CONFIG.ZHIPU_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
          ],
        },
      ],
      max_tokens: 2048,
    };

    const response = await fetchWithAbort(
      VISION_CONFIG.ZHIPU_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${zhipuApiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      VISION_CONFIG.TIMEOUT_MS,
      outerSignal,
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn('screenshot_page vision API failed', {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const result = await response.json();
    return result.choices?.[0]?.message?.content || null;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('screenshot_page vision failed', { error: message });
    return null;
  }
}

export async function executeScreenshotPage(
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

  const params = args as unknown as ScreenshotPageParams;
  if (typeof params.url !== 'string' || params.url.length === 0) {
    return { ok: false, error: 'url is required and must be a string', code: 'INVALID_ARGS' };
  }

  const width = params.width ?? 1280;
  const height = params.height ?? 800;
  const fullPage = params.full_page ?? false;
  const format = params.format ?? 'png';
  const analyze = params.analyze ?? false;
  const analysisPrompt = params.prompt;

  const defaultAnalysisPrompt = `请分析这个网页的内容，包括：
1. 网页的主要用途和类型
2. 主要的内容区域和布局
3. 关键的文字信息和链接
4. 如果有表单、按钮等交互元素，请描述其功能`;

  try {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(params.url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('仅支持 http/https 协议');
      }
    } catch {
      return { ok: false, error: `无效的 URL: ${params.url}`, code: 'INVALID_ARGS' };
    }

    ctx.emit({
      type: 'tool_output',
      tool: 'screenshot_page',
      message: `📸 正在截图: ${parsedUrl.hostname}`,
    } as never);

    let imageBuffer: Buffer | null = null;
    let usedApi = '';

    const apis: Array<{ name: string; fn: () => Promise<Buffer> }> = [
      { name: 'Thum.io', fn: () => screenshotViaThumio(params.url, width, ctx.abortSignal) },
      {
        name: 'Microlink',
        fn: () =>
          screenshotViaMicrolink(
            params.url,
            { width, height, fullPage, format },
            ctx.abortSignal,
          ),
      },
    ];

    for (const api of apis) {
      if (ctx.abortSignal.aborted) {
        return { ok: false, error: 'aborted', code: 'ABORTED' };
      }
      try {
        imageBuffer = await api.fn();
        usedApi = api.name;
        break;
      } catch (e: unknown) {
        ctx.logger.warn(`${api.name} failed`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    if (!imageBuffer) {
      return { ok: false, error: '所有截图 API 都失败了，请稍后重试', code: 'NETWORK_ERROR' };
    }

    const timestamp = Date.now();
    const hostname = parsedUrl.hostname.replace(/\./g, '_');
    const fileName = `screenshot_${hostname}_${timestamp}.${format}`;
    const outputDir = params.output_path ? path.dirname(params.output_path) : ctx.workingDir;
    const finalPath = params.output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(finalPath, imageBuffer);
    const stats = fs.statSync(finalPath);

    ctx.logger.debug('screenshot_page done', {
      url: params.url,
      path: finalPath,
      size: stats.size,
      api: usedApi,
    });

    let output = `✅ 网页截图完成！

🌐 URL: ${params.url}
📐 尺寸: ${width}x${height}
📄 格式: ${format.toUpperCase()}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`;

    let analysis: string | null = null;
    if (analyze) {
      ctx.emit({
        type: 'tool_output',
        tool: 'screenshot_page',
        message: '🔍 正在分析网页内容...',
      } as never);

      analysis = await analyzeWithVision(
        finalPath,
        analysisPrompt || defaultAnalysisPrompt,
        ctx.abortSignal,
        ctx.logger,
      );
      if (analysis) {
        output += `\n\n📝 AI 分析结果:\n${analysis}`;
      }
    }

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
        filePath: finalPath,
        fileName: path.basename(finalPath),
        fileSize: stats.size,
        url: params.url,
        width,
        height,
        fullPage,
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
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('screenshot_page failed', { error: message });
    return { ok: false, error: `网页截图失败: ${message}` };
  }
}

class ScreenshotPageHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeScreenshotPage(args, ctx, canUseTool, onProgress);
  }
}

export const screenshotPageModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ScreenshotPageHandler();
  },
};
