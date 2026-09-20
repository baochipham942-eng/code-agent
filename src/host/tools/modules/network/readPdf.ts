// ============================================================================
// read_pdf (P0-6.3 Batch 8 — network: native ToolModule rewrite)
//
// OpenRouter 已配置：视觉模型（Gemini 2.0）解析 PDF。
// 未配置：本地 pdftotext 抽可选中文本；prompt 不生效。
// ============================================================================

import { execFile } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
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
import { MODEL_API_ENDPOINTS, NETWORK_TOOL_TIMEOUTS } from '../../../../shared/constants';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { readPdfSchema as schema } from './readPdf.schema';
import { TOOL_DEPENDENCY_HINTS } from '../_helpers/dependencyHints';

function isAbortLike(error: unknown, abortSignal: AbortSignal): boolean {
  if (abortSignal.aborted) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const name = (error as { name?: string }).name;
  return code === 'ABORT_ERR' || code === 'ABORTED' || name === 'AbortError';
}

function isMissingBinary(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  const rawMessage = (error as { message?: unknown }).message;
  const message = typeof rawMessage === 'string'
    ? rawMessage
    : error instanceof Error
      ? error.message
      : String(error);
  return code === 'ENOENT' || /\bENOENT\b/.test(message) || /not found/i.test(message);
}

function runPdftotext(bin: string, filePath: string, abortSignal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (abortSignal.aborted) {
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
      return;
    }
    execFile(
      bin,
      ['-layout', filePath, '-'],
      {
        maxBuffer: 50 * 1024 * 1024,
        timeout: NETWORK_TOOL_TIMEOUTS.PDF_TEXT_EXTRACT,
        signal: abortSignal,
      },
      (error, stdout, stderr) => {
        if (isAbortLike(error, abortSignal)) {
          reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
          return;
        }
        if (error) {
          const execError = error as NodeJS.ErrnoException & { killed?: boolean };
          if (execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(Object.assign(new Error('pdftotext output exceeded maxBuffer'), { code: 'MAXBUFFER' }));
            return;
          }
          if (execError.killed) {
            reject(Object.assign(new Error('pdftotext timed out'), { code: 'TIMEOUT' }));
            return;
          }
          const detail = String(stderr ?? '').trim();
          if (detail) execError.message = `${execError.message}: ${detail}`.slice(0, 500);
          reject(execError);
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout ?? ''));
      },
    );
  });
}

const VisionCompletionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()).optional().default([]),
}).passthrough();

/**
 * 直接调用 OpenRouter API（需要本地 API Key）
 */
async function callDirectOpenRouter(apiKey: string, body: unknown): Promise<Response> {
  return fetch(`${MODEL_API_ENDPOINTS.openrouter}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://code-agent.app',
      'X-Title': 'Agent Neo',
    },
    body: JSON.stringify(body),
  });
}

/**
 * 调用视觉模型处理 PDF（需要本地 OpenRouter API Key）
 * 注意：智谱 GLM-4.6V 不支持 PDF，只能用 Gemini
 */
async function processWithVisionModel(
  filePath: string,
  prompt: string,
  ctx: ToolContext,
): Promise<{ content: string }> {
  const configService = getConfigService();
  const apiKey = configService.getApiKey('openrouter');
  if (!apiKey) {
    throw new Error(TOOL_DEPENDENCY_HINTS.readPdfOpenRouter);
  }

  // 读取 PDF 并转换为 base64
  const pdfData = await fs.readFile(filePath);
  const base64Pdf = pdfData.toString('base64');

  const requestBody = {
    model: 'google/gemini-2.0-flash-001',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'file',
            file: {
              filename: path.basename(filePath),
              file_data: `data:application/pdf;base64,${base64Pdf}`,
            },
          },
        ],
      },
    ],
    max_tokens: 8192,
  };

  ctx.logger.info('[PDF解析] 使用 OpenRouter Gemini');
  const directResponse = await callDirectOpenRouter(apiKey, requestBody);
  if (directResponse.ok) {
    const payload: unknown = await directResponse.json();
    const result = VisionCompletionResponseSchema.safeParse(payload);
    return {
      content: result.success
        ? result.data.choices[0]?.message?.content || '无法解析 PDF 内容'
        : '无法解析 PDF 内容',
    };
  }
  const errorText = await directResponse.text();
  ctx.logger.warn('[PDF解析] OpenRouter 失败', { status: directResponse.status, error: errorText });
  throw new Error(`PDF 解析失败: OpenRouter ${directResponse.status} ${errorText.substring(0, 200)}`);
}

export async function executeReadPdf(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const filePathArg = args.file_path;
  const prompt = (args.prompt as string | undefined) ||
    '请阅读并详细描述这个 PDF 文件的内容，包括所有文字、表格和图表。如果是代码或技术文档，请保留格式。';

  if (typeof filePathArg !== 'string' || filePathArg.length === 0) {
    return { ok: false, error: 'file_path is required and must be a string', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'read_pdf' });

  let filePath = filePathArg;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(ctx.workingDir, filePath);
  }

  try {
    await fs.access(filePath);

    if (!filePath.toLowerCase().endsWith('.pdf')) {
      return { ok: false, error: '文件不是 PDF 格式', code: 'INVALID_ARGS' };
    }

    const stats = await fs.stat(filePath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

    const apiKey = getConfigService().getApiKey('openrouter');
    if (apiKey) {
      onProgress?.({
        stage: 'running',
        detail: `正在使用视觉模型处理 PDF (${fileSizeMB} MB)...`,
      });
      const result = await processWithVisionModel(filePath, prompt, ctx);
      return finishPdfResult(filePath, fileSizeMB, 'vision', result.content, ctx, onProgress);
    }

    onProgress?.({
      stage: 'running',
      detail: `未配置 OpenRouter，改用本地文本抽取 (${fileSizeMB} MB)...`,
    });
    const text = await extractSelectablePdfText(filePath, ctx.abortSignal, ctx.logger);
    return finishPdfResult(filePath, fileSizeMB, 'text', text, ctx, onProgress);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode = (error as { code?: string }).code;
    if (errCode === 'ENOENT') {
      return { ok: false, error: `文件不存在: ${filePath}`, code: 'ENOENT' };
    }
    if (isAbortLike(error, ctx.abortSignal)) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }
    if (errCode === 'TIMEOUT') {
      return { ok: false, error: errMsg || 'pdftotext timed out', code: 'TIMEOUT' };
    }
    ctx.logger.error('PDF read failed', { error: errMsg });
    return { ok: false, error: errMsg || '读取 PDF 失败', code: 'NETWORK_ERROR' };
  }
}

async function extractSelectablePdfText(
  filePath: string,
  abortSignal: AbortSignal,
  logger: ToolContext['logger'],
): Promise<string> {
  // Sidecar 只打包 pdftoppm，不把 bundled poppler/bin/pdftotext 当候选。
  const bins = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', 'pdftotext'];
  const attempts: Array<{ bin: string; code?: string; message: string }> = [];
  for (const bin of bins) {
    if (abortSignal.aborted) {
      throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
    }
    try {
      const stdout = await runPdftotext(bin, filePath, abortSignal);
      if (stdout.trim()) return stdout;
      attempts.push({ bin, message: 'empty text' });
      logger.warn('pdftotext candidate returned empty text', { bin });
    } catch (error) {
      if (isAbortLike(error, abortSignal)) {
        throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
      }
      const code = (error as { code?: string }).code;
      if (code === 'TIMEOUT' || code === 'MAXBUFFER') {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ bin, code, message });
      logger.warn('pdftotext candidate failed', { bin, code, message });
    }
  }
  const lastReal = [...attempts].reverse().find((attempt) => !isMissingBinary(attempt));
  const detail = lastReal
    ? `${lastReal.bin}: ${lastReal.message}`
    : '未安装 poppler。安装：brew install poppler';
  throw new Error(`${TOOL_DEPENDENCY_HINTS.readPdfOpenRouter} 本地 pdftotext 失败：${detail}`);
}

async function finishPdfResult(
  filePath: string,
  fileSizeMB: string,
  method: 'vision' | 'text',
  content: string,
  ctx: ToolContext,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const methodLabel = method === 'vision' ? '视觉模型 (Gemini 2.0)' : '本地文本抽取';
  let output = `📄 PDF 分析结果\n`;
  output += `文件: ${path.basename(filePath)} (${fileSizeMB} MB)\n`;
  output += `处理方式: ${methodLabel}\n`;
  if (method === 'text') {
    output += `说明: prompt 未生效（本地抽取不支持指令）\n`;
  }
  output += `\n`;
  output += content;
  onProgress?.({ stage: 'completing', percent: 100 });
  return {
    ok: true,
    output,
    meta: {
      artifact: await createFileArtifact(filePath, schema.name, ctx, {
        kind: 'document',
        mimeType: 'application/pdf',
        preview: content.slice(0, 500),
        metadata: {
          processingMethod: method,
          fileSizeMB: parseFloat(fileSizeMB),
        },
      }),
      processingMethod: method,
      fileSizeMB: parseFloat(fileSizeMB),
    },
  };
}

class ReadPdfHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeReadPdf(args, ctx, canUseTool, onProgress);
  }
}

export const readPdfModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ReadPdfHandler();
  },
};
