// ============================================================================
// Read PDF Tool - Smart PDF processing with text extraction + vision fallback
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { getConfigService } from '../../services/ConfigService';

// pdfjs-dist 延迟加载，避免在模块加载时触发 DOMMatrix 错误
let pdfjsLib: typeof import('pdfjs-dist') | null = null;

async function getPdfjs() {
  if (!pdfjsLib) {
    // 使用 legacy 版本，兼容 Node.js 环境（无 DOM 依赖）
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // @ts-ignore - 禁用 worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  }
  return pdfjsLib;
}

// 最小有效文本阈值（字符数），低于此值认为是扫描版 PDF
const SCANNED_PDF_THRESHOLD = 100;

interface PdfExtractionResult {
  text: string;
  pageCount: number;
  isScanned: boolean;
  extractedCharCount: number;
}

/**
 * 使用 pdfjs-dist 提取 PDF 文本
 */
async function extractTextFromPdf(filePath: string): Promise<PdfExtractionResult> {
  const pdfjs = await getPdfjs();
  const data = await fs.readFile(filePath);
  const pdf = await pdfjs.getDocument({ data }).promise;

  let fullText = '';
  const pageCount = pdf.numPages;

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    fullText += `\n--- Page ${i} ---\n${pageText}`;
  }

  const trimmedText = fullText.trim();
  const extractedCharCount = trimmedText.replace(/\s+/g, '').length;

  return {
    text: trimmedText,
    pageCount,
    isScanned: extractedCharCount < SCANNED_PDF_THRESHOLD * pageCount,
    extractedCharCount,
  };
}

/**
 * 调用 OpenRouter 视觉模型处理扫描版 PDF
 */
async function processWithVisionModel(
  filePath: string,
  prompt: string
): Promise<string> {
  const configService = getConfigService();
  const apiKey = configService.getApiKey('openrouter');

  if (!apiKey) {
    throw new Error('OpenRouter API Key 未配置，无法处理扫描版 PDF。请在设置中配置 OpenRouter API Key。');
  }

  // 读取 PDF 并转换为 base64
  const pdfData = await fs.readFile(filePath);
  const base64Pdf = pdfData.toString('base64');

  // 使用 Gemini 2.0 Flash 处理（支持 PDF 原生输入）
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://code-agent.app',
      'X-Title': 'Code Agent',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt || '请阅读并总结这个 PDF 文件的内容。',
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
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API 调用失败: ${error}`);
  }

  const result = await response.json();
  return result.choices?.[0]?.message?.content || '无法解析 PDF 内容';
}

export const readPdfTool: Tool = {
  name: 'read_pdf',
  description: `Smart PDF reading tool with automatic fallback.

Strategy:
1. First attempts text extraction using pdfjs-dist (fast, free)
2. If text extraction yields minimal content (scanned PDF), falls back to OpenRouter vision model (Gemini 2.0)

Parameters:
- file_path: Absolute path to the PDF file
- prompt: (Optional) Specific question or instruction for the vision model
- force_vision: (Optional) Force using vision model even if text extraction succeeds

Returns:
- Extracted text content with page numbers
- For scanned PDFs: AI-generated description/transcription

Best for:
- Reading text-based PDFs (technical docs, code, reports)
- Processing scanned documents and images
- Analyzing PDF forms and diagrams`,
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
        description: 'Specific question or instruction for vision model processing',
      },
      force_vision: {
        type: 'boolean',
        description: 'Force using vision model even if text extraction succeeds',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    let filePath = params.file_path as string;
    const prompt = params.prompt as string | undefined;
    const forceVision = params.force_vision as boolean | undefined;

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

      // Step 1: Try text extraction
      const extraction = await extractTextFromPdf(filePath);

      // Step 2: Decide whether to use vision model
      const shouldUseVision = forceVision || extraction.isScanned;

      if (shouldUseVision) {
        // Use vision model for scanned PDFs
        context.emit?.('tool_output', {
          tool: 'read_pdf',
          message: extraction.isScanned
            ? `检测到扫描版 PDF (仅提取到 ${extraction.extractedCharCount} 字符)，正在使用视觉模型处理...`
            : '强制使用视觉模型处理...',
        });

        try {
          const visionResult = await processWithVisionModel(
            filePath,
            prompt || '请阅读并详细描述这个 PDF 文件的内容，包括所有文字、表格和图表。'
          );

          // 如果文本提取有内容，将两者结合
          let combinedOutput = `📄 PDF 分析结果 (${extraction.pageCount} 页)\n`;
          combinedOutput += `处理方式: 视觉模型 (Gemini 2.0)\n\n`;
          combinedOutput += visionResult;

          if (extraction.extractedCharCount > 0) {
            combinedOutput += `\n\n---\n📝 文本提取补充 (${extraction.extractedCharCount} 字符):\n`;
            combinedOutput += extraction.text.substring(0, 2000);
            if (extraction.text.length > 2000) {
              combinedOutput += '\n... (文本已截断)';
            }
          }

          return {
            success: true,
            output: combinedOutput,
            metadata: {
              pageCount: extraction.pageCount,
              processingMethod: 'vision',
              isScanned: extraction.isScanned,
            },
          };
        } catch (visionError: any) {
          // 视觉模型失败，回退到纯文本（如果有的话）
          if (extraction.extractedCharCount > 0) {
            return {
              success: true,
              output: `⚠️ 视觉模型处理失败: ${visionError.message}\n\n回退到文本提取结果:\n${extraction.text}`,
              metadata: {
                pageCount: extraction.pageCount,
                processingMethod: 'text_fallback',
                visionError: visionError.message,
              },
            };
          }
          throw visionError;
        }
      }

      // Text extraction successful
      let output = `📄 PDF 内容 (${extraction.pageCount} 页, ${extraction.extractedCharCount} 字符)\n`;
      output += `处理方式: 文本提取\n\n`;
      output += extraction.text;

      return {
        success: true,
        output,
        metadata: {
          pageCount: extraction.pageCount,
          processingMethod: 'text',
          extractedCharCount: extraction.extractedCharCount,
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
