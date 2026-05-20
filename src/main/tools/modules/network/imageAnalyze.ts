// ============================================================================
// image_analyze (P1 Wave 4 D2c — network/media: native ToolModule)
//
// 把 legacy ImageAnalyzeTool 迁移到 native：单图分析 + 批量 glob 筛选两种
// 模式 + 视觉模型 fallback（智谱 GLM-4.6V > OpenRouter Gemini）。
//
// abort signal 走 race-and-abandon：每个 fetch 都有内置 AbortController 与
// outerSignal 联动；批量并行处理时每批前检查 abort。
// ============================================================================

import fsPromises from 'fs/promises';
import * as path from 'path';
import { glob } from 'glob';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { z } from 'zod';
import { getConfigService } from '../../../services';
import {
  MODEL_API_ENDPOINTS,
  ZHIPU_VISION_MODEL,
  MODEL_MAX_TOKENS,
} from '../../../../shared/constants';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
import { imageAnalyzeSchema as schema } from './imageAnalyze.schema';

const CONFIG = {
  OPENROUTER_MODEL: 'google/gemini-2.0-flash-001',
  ZHIPU_MODEL: ZHIPU_VISION_MODEL,
  ZHIPU_MAX_TOKENS: MODEL_MAX_TOKENS.VISION,
  MAX_PARALLEL: 10,
  TIMEOUT_MS: 30000,
  SUPPORTED_FORMATS: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'],
  MAX_IMAGE_SIZE_MB: 20,
};

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

interface ImageAnalyzeParams {
  path?: string;
  prompt?: string;
  paths?: string[];
  filter?: string;
  detail?: 'low' | 'high';
}

interface AnalysisResult {
  path: string;
  success: boolean;
  content?: string;
  matched?: boolean;
  error?: string;
}

const VisionCompletionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional().default([]),
}).passthrough();

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

async function callDirectOpenRouter(
  apiKey: string,
  body: unknown,
  outerSignal: AbortSignal,
): Promise<Response> {
  return fetchWithAbort(
    `${MODEL_API_ENDPOINTS.openrouter}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://code-agent.app',
        'X-Title': 'Agent Neo',
      },
      body: JSON.stringify(body),
    },
    CONFIG.TIMEOUT_MS,
    outerSignal,
  );
}

async function callZhipuVision(
  apiKey: string,
  base64Image: string,
  mimeType: string,
  prompt: string,
  outerSignal: AbortSignal,
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
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          },
        ],
      },
    ],
    max_tokens: CONFIG.ZHIPU_MAX_TOKENS,
  };

  const response = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.zhipuCoding}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    },
    CONFIG.TIMEOUT_MS,
    outerSignal,
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`智谱视觉 API 错误: ${response.status} - ${error}`);
  }

  const payload: unknown = await response.json();
  const result = VisionCompletionResponseSchema.safeParse(payload);
  return result.success ? result.data.choices[0]?.message?.content || '' : '';
}

async function analyzeImage(
  imagePath: string,
  prompt: string,
  detail: 'low' | 'high',
  outerSignal: AbortSignal,
  logger: ToolContext['logger'],
): Promise<string> {
  const imageData = await fsPromises.readFile(imagePath);
  const base64Image = imageData.toString('base64');
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'image/jpeg';

  const configService = getConfigService();

  const zhipuApiKey = configService.getApiKey('zhipu');
  if (zhipuApiKey) {
    try {
      return await callZhipuVision(zhipuApiKey, base64Image, mimeType, prompt, outerSignal);
    } catch (error: unknown) {
      if (outerSignal.aborted) throw error;
      logger.warn('image_analyze zhipu vision failed, fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
      const directResponse = await callDirectOpenRouter(
        openrouterApiKey,
        requestBody,
        outerSignal,
      );
      if (directResponse.ok) {
        const payload: unknown = await directResponse.json();
        const result = VisionCompletionResponseSchema.safeParse(payload);
        return result.success ? result.data.choices[0]?.message?.content || '' : '';
      }
    } catch (error: unknown) {
      if (outerSignal.aborted) throw error;
      logger.warn('image_analyze openrouter failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new Error('所有视觉 API 均不可用。请在设置中配置智谱或 OpenRouter API Key。');
}

async function checkImageMatch(
  imagePath: string,
  filter: string,
  detail: 'low' | 'high',
  outerSignal: AbortSignal,
  logger: ToolContext['logger'],
): Promise<boolean> {
  const prompt = `判断这张图片是否符合以下条件：「${filter}」

请只回答 YES 或 NO，不要其他内容。`;
  const response = await analyzeImage(imagePath, prompt, detail, outerSignal, logger);
  return response.trim().toUpperCase().includes('YES');
}

async function expandPaths(patterns: string[], workingDir: string): Promise<string[]> {
  const allPaths: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*') && !pattern.includes('?')) {
      const absPath = path.isAbsolute(pattern) ? pattern : path.join(workingDir, pattern);
      allPaths.push(absPath);
      continue;
    }
    const matches = await glob(pattern, {
      cwd: workingDir,
      absolute: true,
      nodir: true,
    });
    allPaths.push(...matches);
  }
  return allPaths.filter((p) => CONFIG.SUPPORTED_FORMATS.includes(path.extname(p).toLowerCase()));
}

async function processInParallel<T>(
  items: T[],
  processor: (item: T) => Promise<AnalysisResult>,
  maxParallel: number,
  outerSignal: AbortSignal,
  onProgress?: (completed: number, total: number) => void,
): Promise<AnalysisResult[]> {
  const results: AnalysisResult[] = [];
  let completed = 0;
  for (let i = 0; i < items.length; i += maxParallel) {
    if (outerSignal.aborted) throw new Error('aborted');
    const batch = items.slice(i, i + maxParallel);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    completed += batch.length;
    onProgress?.(completed, items.length);
  }
  return results;
}

export async function executeImageAnalyze(
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

  const params = args as unknown as ImageAnalyzeParams;
  const { path: singlePath, paths, filter } = params;
  const prompt = params.prompt || '描述这张图片的内容';
  const detail = params.detail || 'low';

  const startTime = Date.now();

  try {
    if (singlePath) {
      const absPath = path.isAbsolute(singlePath)
        ? singlePath
        : path.join(ctx.workingDir, singlePath);

      try {
        await fsPromises.access(absPath);
      } catch {
        return { ok: false, error: `文件不存在: ${absPath}`, code: 'FS_ERROR' };
      }

      const ext = path.extname(absPath).toLowerCase();
      if (!CONFIG.SUPPORTED_FORMATS.includes(ext)) {
        return {
          ok: false,
          error: `不支持的图片格式: ${ext}。支持: ${CONFIG.SUPPORTED_FORMATS.join(', ')}`,
          code: 'INVALID_ARGS',
        };
      }

      const stats = await fsPromises.stat(absPath);
      const sizeMB = stats.size / (1024 * 1024);
      if (sizeMB > CONFIG.MAX_IMAGE_SIZE_MB) {
        return {
          ok: false,
          error: `文件过大: ${sizeMB.toFixed(1)}MB，最大支持 ${CONFIG.MAX_IMAGE_SIZE_MB}MB`,
          code: 'INVALID_ARGS',
        };
      }

      ctx.emit({
        type: 'tool_output',
        tool: 'image_analyze',
        message: `🔍 正在分析图片: ${path.basename(absPath)}`,
      } as never);

      const content = await analyzeImage(absPath, prompt, detail, ctx.abortSignal, ctx.logger);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      onProgress?.({ stage: 'completing', percent: 100 });

      return {
        ok: true,
        output: `📷 图片分析结果\n文件: ${path.basename(absPath)}\n耗时: ${elapsed}s\n\n${content}`,
        meta: {
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `Image analysis: ${path.basename(absPath)}`,
            mimeType: 'text/markdown',
            contentLength: content.length,
            preview: content.slice(0, 500),
            metadata: {
              imagePath: absPath,
              prompt,
              detail,
              mediaKind: 'image',
            },
          }),
          path: absPath,
          imagePath: absPath,
          prompt,
          detail,
          mediaKind: 'image',
          contentLength: content.length,
          truncated: false,
          elapsedSeconds: parseFloat(elapsed),
        },
      };
    }

    if (paths && filter) {
      const imagePaths = await expandPaths(paths, ctx.workingDir);
      if (imagePaths.length === 0) {
        return { ok: false, error: '未找到匹配的图片文件', code: 'FS_ERROR' };
      }

      ctx.emit({
        type: 'tool_output',
        tool: 'image_analyze',
        message: `🔍 开始筛选 ${imagePaths.length} 张图片，条件: "${filter}"`,
      } as never);

      const results = await processInParallel(
        imagePaths,
        async (imgPath) => {
          try {
            const matched = await checkImageMatch(
              imgPath,
              filter,
              detail,
              ctx.abortSignal,
              ctx.logger,
            );
            return { path: imgPath, success: true, matched };
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.warn('image_analyze single failed', { path: imgPath, error: message });
            return { path: imgPath, success: false, error: message };
          }
        },
        CONFIG.MAX_PARALLEL,
        ctx.abortSignal,
        (completed, total) => {
          ctx.emit({
            type: 'tool_output',
            tool: 'image_analyze',
            message: `⏳ 进度: ${completed}/${total}`,
          } as never);
        },
      );

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

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

      onProgress?.({ stage: 'completing', percent: 100 });

      return {
        ok: true,
        output,
        meta: {
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'text',
            sessionId: ctx.sessionId,
            name: `Image filter: ${filter.slice(0, 80)}`,
            mimeType: 'text/markdown',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              filter,
              total: imagePaths.length,
              matched: matched.length,
              failed: failed.length,
              mediaKind: 'image',
            },
          }),
          total: imagePaths.length,
          matched: matched.length,
          failed: failed.length,
          filter,
          mediaKind: 'image',
          resultCount: matched.length,
          contentLength: output.length,
          truncated: false,
          matchedPaths: matched.map((r) => r.path),
          elapsedSeconds: parseFloat(elapsed),
        },
      };
    }

    return {
      ok: false,
      error: '参数错误：单图模式需要 path，批量模式需要 paths + filter',
      code: 'INVALID_ARGS',
    };
  } catch (error: unknown) {
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'aborted') {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    ctx.logger.warn('image_analyze failed', { error: message });
    return { ok: false, error: `图片分析失败: ${message}` };
  }
}

class ImageAnalyzeHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeImageAnalyze(args, ctx, canUseTool, onProgress);
  }
}

export const imageAnalyzeModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ImageAnalyzeHandler();
  },
};
