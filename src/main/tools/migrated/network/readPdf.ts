// ============================================================================
// read_pdf (P0-6.3 Batch 8 — network: native ToolModule rewrite)
//
// 使用视觉模型（Gemini 2.0）解析 PDF。
// 优先走云端代理（服务端注入 API Key），本地 Key 作为备用。
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { getConfigService } from '../../../services';
import { CLOUD_ENDPOINTS, MODEL_API_ENDPOINTS } from '../../../../shared/constants';

const schema: ToolSchema = {
  name: 'read_pdf',
  description: `Read PDF files using vision model (Gemini 2.0).

Parameters:
- file_path: Absolute path to the PDF file
- prompt: (Optional) Specific question or instruction for analyzing the PDF

Returns:
- AI-generated analysis/transcription of the PDF content

Best for:
- Reading text-based PDFs (technical docs, code, reports)
- Processing scanned documents and images
- Analyzing PDF forms, diagrams and charts`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the PDF file',
      },
      prompt: {
        type: 'string',
        description: 'Specific question or instruction for analyzing the PDF',
      },
    },
    required: ['file_path'],
  },
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};

/**
 * 通过云端代理调用模型 API（服务端注入 API Key）
 */
async function callViaCloudProxy(
  provider: string,
  endpoint: string,
  body: unknown,
): Promise<Response> {
  return fetch(CLOUD_ENDPOINTS.modelProxy, {
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
}

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
      'X-Title': 'Code Agent',
    },
    body: JSON.stringify(body),
  });
}

/**
 * 调用视觉模型处理 PDF
 * 优先级：OpenRouter 本地 Key > 云端代理
 * 注意：智谱 GLM-4.6V 不支持 PDF，只能用 Gemini
 */
async function processWithVisionModel(
  filePath: string,
  prompt: string,
  ctx: ToolContext,
): Promise<{ content: string }> {
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

  const configService = getConfigService();

  // 1. 优先使用本地 OpenRouter API Key（避免云端代理限制）
  const apiKey = configService.getApiKey('openrouter');
  if (apiKey) {
    try {
      ctx.logger.info('[PDF解析] 使用 OpenRouter Gemini (本地 Key)');
      const directResponse = await callDirectOpenRouter(apiKey, requestBody);
      if (directResponse.ok) {
        const result = await directResponse.json();
        return { content: result.choices?.[0]?.message?.content || '无法解析 PDF 内容' };
      }
      const errorText = await directResponse.text();
      ctx.logger.warn('[PDF解析] OpenRouter 失败', { status: directResponse.status, error: errorText });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn('[PDF解析] OpenRouter 错误', { error: message });
    }
  }

  // 2. 回退到云端代理
  try {
    ctx.logger.info('[PDF解析] 使用云端代理');
    const cloudResponse = await callViaCloudProxy('openrouter', '/chat/completions', requestBody);
    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      return { content: result.choices?.[0]?.message?.content || '无法解析 PDF 内容' };
    }
    const errorText = await cloudResponse.text();
    ctx.logger.warn('[PDF解析] 云端代理失败', { status: cloudResponse.status, error: errorText });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('[PDF解析] 云端代理错误', { error: message });
  }

  throw new Error('PDF 解析失败。请配置 OpenRouter API Key 或检查网络连接。');
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

    onProgress?.({
      stage: 'running',
      detail: `正在使用视觉模型处理 PDF (${fileSizeMB} MB)...`,
    });

    const result = await processWithVisionModel(filePath, prompt, ctx);

    let output = `📄 PDF 分析结果\n`;
    output += `文件: ${path.basename(filePath)} (${fileSizeMB} MB)\n`;
    output += `处理方式: 视觉模型 (Gemini 2.0)\n\n`;
    output += result.content;

    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output,
      meta: {
        processingMethod: 'vision',
        fileSizeMB: parseFloat(fileSizeMB),
      },
    };
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: false, error: `文件不存在: ${filePath}`, code: 'ENOENT' };
    }
    ctx.logger.error('PDF read failed', { error: errMsg });
    return { ok: false, error: errMsg || '读取 PDF 失败', code: 'NETWORK_ERROR' };
  }
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
