// ============================================================================
// Read PDF Tool - 使用视觉模型解析 PDF
// 优先走云端代理（服务端注入 API Key），本地 Key 作为备用
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getConfigService } from '../../services';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ReadPdf');

/**
 * 获取云端 API URL
 */
function getCloudApiUrl(): string {
  const configService = getConfigService();
  const settings = configService.getSettings();
  return process.env.CLOUD_API_URL || settings.cloudApi?.url || 'https://code-agent-beta.vercel.app';
}

/**
 * 通过云端代理调用模型 API（服务端注入 API Key）
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
 * 直接调用 OpenRouter API（需要本地 API Key）
 */
async function callDirectOpenRouter(
  apiKey: string,
  body: unknown
): Promise<Response> {
  return fetch('https://openrouter.ai/api/v1/chat/completions', {
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
 * 优先使用云端代理，失败时回退到本地 API Key
 */
async function processWithVisionModel(
  filePath: string,
  prompt: string
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
          {
            type: 'text',
            text: prompt,
          },
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

  // 1. 优先尝试云端代理
  try {
    logger.info('Trying cloud proxy...');
    const cloudResponse = await callViaCloudProxy('openrouter', '/chat/completions', requestBody);

    if (cloudResponse.ok) {
      const result = await cloudResponse.json();
      logger.info('Cloud proxy success');
      return {
        content: result.choices?.[0]?.message?.content || '无法解析 PDF 内容',
      };
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
    throw new Error('OpenRouter API Key 未配置，且云端代理不可用。请在设置中配置 OpenRouter API Key。');
  }

  const directResponse = await callDirectOpenRouter(apiKey, requestBody);

  if (!directResponse.ok) {
    const error = await directResponse.text();
    throw new Error(`OpenRouter API 调用失败: ${error}`);
  }

  const result = await directResponse.json();
  return {
    content: result.choices?.[0]?.message?.content || '无法解析 PDF 内容',
  };
}

export const readPdfTool: Tool = {
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
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
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

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let filePath = params.file_path as string;
    const prompt = (params.prompt as string) || '请阅读并详细描述这个 PDF 文件的内容，包括所有文字、表格和图表。如果是代码或技术文档，请保留格式。';

    // Resolve relative paths
    if (!path.isAbsolute(filePath)) {
      filePath = path.join(context.workingDirectory, filePath);
    }

    try {
      // Check if file exists
      await fs.access(filePath);

      // Check file extension
      if (!filePath.toLowerCase().endsWith('.pdf')) {
        return {
          success: false,
          error: '文件不是 PDF 格式',
        };
      }

      // Get file size for info
      const stats = await fs.stat(filePath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      context.emit?.('tool_output', {
        tool: 'read_pdf',
        message: `正在使用视觉模型处理 PDF (${fileSizeMB} MB)...`,
      });

      const result = await processWithVisionModel(filePath, prompt);

      let output = `📄 PDF 分析结果\n`;
      output += `文件: ${path.basename(filePath)} (${fileSizeMB} MB)\n`;
      output += `处理方式: 视觉模型 (Gemini 2.0)\n\n`;
      output += result.content;

      return {
        success: true,
        output,
        metadata: {
          processingMethod: 'vision',
          fileSizeMB: parseFloat(fileSizeMB),
        },
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          success: false,
          error: `文件不存在: ${filePath}`,
        };
      }
      return {
        success: false,
        error: error.message || '读取 PDF 失败',
      };
    }
  },
};
