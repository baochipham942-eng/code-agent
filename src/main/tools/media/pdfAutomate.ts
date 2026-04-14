// ============================================================================
// PdfAutomate - Unified PDF automation tool
// ============================================================================
// Consolidates PDF generate, compress, read, merge, split, extract_tables,
// and convert_to_docx into a single tool with action-based dispatching.
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as path from 'path';
import { pdfGenerateTool } from './pdfGenerate';
import { pdfCompressTool } from './pdfCompress';
import { executeReadPdf } from '../modules/network/readPdf';
import { invokeNativeFromLegacy } from '../modules/_helpers/invokeNativeFromLegacy';
import { executePythonScript } from '../utils/pythonBridge';

type PdfAction = 'generate' | 'compress' | 'read' | 'merge' | 'split' | 'extract_tables' | 'convert_to_docx';

export const PdfAutomateTool: Tool = {
  name: 'PdfAutomate',
  description: `Unified PDF automation tool combining reading, generating, compressing, merging, splitting, table extraction, and conversion.

## Actions:

### generate — Generate a new PDF document
Creates a styled PDF from Markdown content.

Parameters:
- title (required): PDF title
- content (required): Markdown content
- theme: "default" | "academic" | "minimal"
- page_size: "A4" | "Letter" | "Legal"
- output_path: Output file path

### compress — Compress a PDF file
Reduces file size using Ghostscript.

Parameters:
- input_path (required): PDF file path
- output_path: Output file path
- quality: "screen" | "ebook" | "printer" | "prepress"

### read — Read PDF content using vision model
Analyzes PDF content using Gemini 2.0.

Parameters:
- file_path (required): PDF file path
- prompt: Specific question or instruction

### merge — Merge multiple PDFs into one
Parameters:
- input_files (required): Array of PDF file paths
- output_path (required): Output file path

### split — Split PDF by page ranges
Parameters:
- input_path (required): PDF file path
- ranges (required): Array of { start, end, output } (0-indexed pages)

### extract_tables — Extract tables from PDF
Parameters:
- input_path (required): PDF file path
- pages: Array of page numbers (0-indexed, optional)

### convert_to_docx — Convert PDF to Word document
Parameters:
- input_path (required): PDF file path
- output_path: Output DOCX file path
- start_page: Start page (0-indexed)
- end_page: End page (exclusive)`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['generate', 'compress', 'read', 'merge', 'split', 'extract_tables', 'convert_to_docx'],
        description: 'The PDF action to perform',
      },
      // generate params
      title: { type: 'string', description: '[generate] PDF title' },
      content: { type: 'string', description: '[generate] Markdown content' },
      theme: { type: 'string', enum: ['default', 'academic', 'minimal'], description: '[generate] Theme' },
      page_size: { type: 'string', enum: ['A4', 'Letter', 'Legal'], description: '[generate] Page size' },
      author: { type: 'string', description: '[generate] Author name' },
      // compress params
      input_path: { type: 'string', description: '[compress/split/extract_tables/convert_to_docx] Input PDF path' },
      quality: { type: 'string', enum: ['screen', 'ebook', 'printer', 'prepress'], description: '[compress] Quality level' },
      // read params
      file_path: { type: 'string', description: '[read] PDF file path' },
      prompt: { type: 'string', description: '[read] Analysis instruction' },
      // merge params
      input_files: { type: 'array', items: { type: 'string' }, description: '[merge] Array of PDF file paths' },
      // split params
      ranges: { type: 'array', description: '[split] Array of { start, end, output }' },
      // extract_tables params
      pages: { type: 'array', items: { type: 'number' }, description: '[extract_tables] Page numbers (0-indexed)' },
      // shared
      output_path: { type: 'string', description: 'Output file path' },
      // convert_to_docx params
      start_page: { type: 'number', description: '[convert_to_docx] Start page (0-indexed)' },
      end_page: { type: 'number', description: '[convert_to_docx] End page (exclusive)' },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as PdfAction;

    switch (action) {
      case 'generate':
        if (!params.title || !params.content) {
          return { success: false, error: 'action "generate" requires title and content parameters' };
        }
        return pdfGenerateTool.execute(
          { title: params.title, content: params.content, theme: params.theme, page_size: params.page_size, output_path: params.output_path, author: params.author },
          context
        );

      case 'compress':
        if (!params.input_path) {
          return { success: false, error: 'action "compress" requires input_path parameter' };
        }
        return pdfCompressTool.execute(
          { input_path: params.input_path, output_path: params.output_path, quality: params.quality },
          context
        );

      case 'read':
        if (!params.file_path) {
          return { success: false, error: 'action "read" requires file_path parameter' };
        }
        return invokeNativeFromLegacy(
          executeReadPdf,
          { file_path: params.file_path, prompt: params.prompt },
          context,
          'pdf-automate-delegate',
        );

      case 'merge': {
        const inputFiles = params.input_files as string[] | undefined;
        if (!inputFiles || inputFiles.length < 2) {
          return { success: false, error: 'action "merge" requires input_files with at least 2 files' };
        }
        if (!params.output_path) {
          return { success: false, error: 'action "merge" requires output_path parameter' };
        }

        // Resolve relative paths
        const resolvedFiles = inputFiles.map(f =>
          path.isAbsolute(f) ? f : path.join(context.workingDirectory, f)
        );
        const resolvedOutput = path.isAbsolute(params.output_path as string)
          ? params.output_path as string
          : path.join(context.workingDirectory, params.output_path as string);

        const result = await executePythonScript('pdf_tools.py', [
          '--operation', 'merge',
          '--params', JSON.stringify({ input_files: resolvedFiles, output_path: resolvedOutput }),
        ]);

        if (!result.success) {
          return { success: false, error: result.error || 'PDF 合并失败' };
        }

        return {
          success: true,
          output: `✅ PDF 合并完成！\n\n📄 输入: ${inputFiles.length} 个文件\n📄 输出: ${resolvedOutput}\n📦 大小: ${((result.file_size as number) / 1024).toFixed(1)} KB`,
          outputPath: resolvedOutput,
          metadata: result,
        };
      }

      case 'split': {
        const inputPath = params.input_path as string;
        const ranges = params.ranges as Array<{ start: number; end: number; output: string }>;
        if (!inputPath) {
          return { success: false, error: 'action "split" requires input_path parameter' };
        }
        if (!ranges || ranges.length === 0) {
          return { success: false, error: 'action "split" requires ranges parameter' };
        }

        const resolvedInput = path.isAbsolute(inputPath)
          ? inputPath
          : path.join(context.workingDirectory, inputPath);

        // Resolve output paths in ranges
        const resolvedRanges = ranges.map(r => ({
          ...r,
          output: path.isAbsolute(r.output) ? r.output : path.join(context.workingDirectory, r.output),
        }));

        const result = await executePythonScript('pdf_tools.py', [
          '--operation', 'split',
          '--params', JSON.stringify({ input_path: resolvedInput, ranges: resolvedRanges }),
        ]);

        if (!result.success) {
          return { success: false, error: result.error || 'PDF 拆分失败' };
        }

        const outputs = result.outputs as Array<{ output_path: string; pages: string; page_count: number }>;
        const outputInfo = outputs.map(o => `  - ${o.output_path} (${o.pages}, ${o.page_count} 页)`).join('\n');

        return {
          success: true,
          output: `✅ PDF 拆分完成！\n\n📄 源文件: ${path.basename(resolvedInput)} (${result.total_pages} 页)\n📑 输出:\n${outputInfo}`,
          metadata: result,
        };
      }

      case 'extract_tables': {
        const inputPath = params.input_path as string;
        if (!inputPath) {
          return { success: false, error: 'action "extract_tables" requires input_path parameter' };
        }

        const resolvedInput = path.isAbsolute(inputPath)
          ? inputPath
          : path.join(context.workingDirectory, inputPath);

        const result = await executePythonScript('pdf_tools.py', [
          '--operation', 'extract_tables',
          '--params', JSON.stringify({ input_path: resolvedInput, pages: params.pages }),
        ]);

        if (!result.success) {
          return { success: false, error: result.error || 'PDF 表格提取失败' };
        }

        const tables = result.tables as Array<{ page: number; table_index: number; rows: number; columns: number; data: unknown[][] }>;
        let output = `✅ 提取到 ${result.total_tables} 个表格\n\n`;
        for (const table of tables) {
          output += `📊 第 ${table.page} 页 表格 ${table.table_index + 1} (${table.rows} 行 × ${table.columns} 列)\n`;
          // 显示前 5 行预览
          const preview = table.data.slice(0, 5);
          for (const row of preview) {
            output += `  | ${row.map(c => String(c ?? '')).join(' | ')} |\n`;
          }
          if (table.rows > 5) {
            output += `  ... (共 ${table.rows} 行)\n`;
          }
          output += '\n';
        }

        return {
          success: true,
          output,
          metadata: result,
        };
      }

      case 'convert_to_docx': {
        const inputPath = params.input_path as string;
        if (!inputPath) {
          return { success: false, error: 'action "convert_to_docx" requires input_path parameter' };
        }

        const resolvedInput = path.isAbsolute(inputPath)
          ? inputPath
          : path.join(context.workingDirectory, inputPath);

        const outputPath = params.output_path
          ? (path.isAbsolute(params.output_path as string)
            ? params.output_path as string
            : path.join(context.workingDirectory, params.output_path as string))
          : undefined;

        const result = await executePythonScript('pdf_tools.py', [
          '--operation', 'convert_to_docx',
          '--params', JSON.stringify({
            input_path: resolvedInput,
            output_path: outputPath,
            start_page: params.start_page,
            end_page: params.end_page,
          }),
        ]);

        if (!result.success) {
          return { success: false, error: result.error || 'PDF 转 DOCX 失败' };
        }

        return {
          success: true,
          output: `✅ PDF 已转换为 DOCX！\n\n📄 输入: ${path.basename(resolvedInput)}\n📄 输出: ${result.output_path}\n📦 大小: ${((result.file_size as number) / 1024).toFixed(1)} KB`,
          outputPath: result.output_path as string,
          metadata: result,
        };
      }

      default:
        return {
          success: false,
          error: `Unknown action: "${action}". Valid actions: generate, compress, read, merge, split, extract_tables, convert_to_docx`,
        };
    }
  },
};
