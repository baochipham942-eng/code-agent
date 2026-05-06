// ============================================================================
// PdfAutomate (P1 Wave 4 D2b — network/document_generation: native dispatcher)
//
// 7-action 统一 PDF dispatcher：
//   - generate   → 直调 executePdfGenerate (native)
//   - compress   → 直调 executePdfCompress (native)
//   - read       → 直调 executeReadPdf (native, 已就位)
//   - merge / split / extract_tables / convert_to_docx
//                → 仍走 executePythonScript('pdf_tools.py', ...) 桥接 Python 工具链
//
// 行为保真：legacy 输出文案、emoji（✅ 📄 📑 📦 📊）+ metadata 形状 1:1 复刻。
// ============================================================================

import * as path from 'path';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executePythonScript } from '../../utils/pythonBridge';
import { executePdfGenerate } from './pdfGenerate';
import { executePdfCompress } from './pdfCompress';
import { executeReadPdf } from './readPdf';
import { pdfAutomateSchema as schema } from './pdfAutomate.schema';

type PdfAction =
  | 'generate'
  | 'compress'
  | 'read'
  | 'merge'
  | 'split'
  | 'extract_tables'
  | 'convert_to_docx';

const VALID_ACTIONS: PdfAction[] = [
  'generate',
  'compress',
  'read',
  'merge',
  'split',
  'extract_tables',
  'convert_to_docx',
];

interface PdfAutomateParams {
  action: PdfAction;
  // generate
  title?: string;
  content?: string;
  theme?: 'default' | 'academic' | 'minimal';
  page_size?: 'A4' | 'Letter' | 'Legal';
  author?: string;
  // compress
  input_path?: string;
  quality?: 'screen' | 'ebook' | 'printer' | 'prepress';
  // read
  file_path?: string;
  prompt?: string;
  // merge
  input_files?: string[];
  // split
  ranges?: Array<{ start: number; end: number; output: string }>;
  // extract_tables
  pages?: number[];
  // shared
  output_path?: string;
  // convert_to_docx
  start_page?: number;
  end_page?: number;
}

function resolveAbs(p: string, ctx: ToolContext): string {
  return path.isAbsolute(p) ? p : path.join(ctx.workingDir, p);
}

export async function executePdfAutomate(
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

  const params = args as unknown as PdfAutomateParams;
  const action = params.action;

  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action)) {
    return {
      ok: false,
      error: `Unknown action: "${action}". Valid actions: ${VALID_ACTIONS.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  switch (action) {
    case 'generate': {
      if (!params.title || !params.content) {
        return {
          ok: false,
          error: 'action "generate" requires title and content parameters',
          code: 'INVALID_ARGS',
        };
      }
      return executePdfGenerate(
        {
          title: params.title,
          content: params.content,
          theme: params.theme,
          page_size: params.page_size,
          output_path: params.output_path,
          author: params.author,
        },
        ctx,
        canUseTool,
        onProgress,
      );
    }

    case 'compress': {
      if (!params.input_path) {
        return {
          ok: false,
          error: 'action "compress" requires input_path parameter',
          code: 'INVALID_ARGS',
        };
      }
      return executePdfCompress(
        {
          input_path: params.input_path,
          output_path: params.output_path,
          quality: params.quality,
        },
        ctx,
        canUseTool,
        onProgress,
      );
    }

    case 'read': {
      if (!params.file_path) {
        return {
          ok: false,
          error: 'action "read" requires file_path parameter',
          code: 'INVALID_ARGS',
        };
      }
      return executeReadPdf(
        { file_path: params.file_path, prompt: params.prompt },
        ctx,
        canUseTool,
        onProgress,
      );
    }

    case 'merge': {
      const inputFiles = params.input_files;
      if (!inputFiles || inputFiles.length < 2) {
        return {
          ok: false,
          error: 'action "merge" requires input_files with at least 2 files',
          code: 'INVALID_ARGS',
        };
      }
      if (!params.output_path) {
        return {
          ok: false,
          error: 'action "merge" requires output_path parameter',
          code: 'INVALID_ARGS',
        };
      }

      const resolvedFiles = inputFiles.map((f) => resolveAbs(f, ctx));
      const resolvedOutput = resolveAbs(params.output_path, ctx);

      const result = await executePythonScript('pdf_tools.py', [
        '--operation',
        'merge',
        '--params',
        JSON.stringify({ input_files: resolvedFiles, output_path: resolvedOutput }),
      ]);

      if (!result.success) {
        return { ok: false, error: result.error || 'PDF 合并失败' };
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `✅ PDF 合并完成！\n\n📄 输入: ${inputFiles.length} 个文件\n📄 输出: ${resolvedOutput}\n📦 大小: ${((result.file_size as number) / 1024).toFixed(1)} KB`,
        meta: { ...(result as Record<string, unknown>), outputPath: resolvedOutput },
      };
    }

    case 'split': {
      const inputPath = params.input_path;
      const ranges = params.ranges;
      if (!inputPath) {
        return {
          ok: false,
          error: 'action "split" requires input_path parameter',
          code: 'INVALID_ARGS',
        };
      }
      if (!ranges || ranges.length === 0) {
        return {
          ok: false,
          error: 'action "split" requires ranges parameter',
          code: 'INVALID_ARGS',
        };
      }

      const resolvedInput = resolveAbs(inputPath, ctx);
      const resolvedRanges = ranges.map((r) => ({
        ...r,
        output: resolveAbs(r.output, ctx),
      }));

      const result = await executePythonScript('pdf_tools.py', [
        '--operation',
        'split',
        '--params',
        JSON.stringify({ input_path: resolvedInput, ranges: resolvedRanges }),
      ]);

      if (!result.success) {
        return { ok: false, error: result.error || 'PDF 拆分失败' };
      }

      const outputs = result.outputs as Array<{
        output_path: string;
        pages: string;
        page_count: number;
      }>;
      const outputInfo = outputs
        .map((o) => `  - ${o.output_path} (${o.pages}, ${o.page_count} 页)`)
        .join('\n');

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `✅ PDF 拆分完成！\n\n📄 源文件: ${path.basename(resolvedInput)} (${result.total_pages} 页)\n📑 输出:\n${outputInfo}`,
        meta: result as Record<string, unknown>,
      };
    }

    case 'extract_tables': {
      const inputPath = params.input_path;
      if (!inputPath) {
        return {
          ok: false,
          error: 'action "extract_tables" requires input_path parameter',
          code: 'INVALID_ARGS',
        };
      }

      const resolvedInput = resolveAbs(inputPath, ctx);

      const result = await executePythonScript('pdf_tools.py', [
        '--operation',
        'extract_tables',
        '--params',
        JSON.stringify({ input_path: resolvedInput, pages: params.pages }),
      ]);

      if (!result.success) {
        return { ok: false, error: result.error || 'PDF 表格提取失败' };
      }

      const tables = result.tables as Array<{
        page: number;
        table_index: number;
        rows: number;
        columns: number;
        data: unknown[][];
      }>;
      let output = `✅ 提取到 ${result.total_tables} 个表格\n\n`;
      for (const table of tables) {
        output += `📊 第 ${table.page} 页 表格 ${table.table_index + 1} (${table.rows} 行 × ${table.columns} 列)\n`;
        const preview = table.data.slice(0, 5);
        for (const row of preview) {
          output += `  | ${row.map((c) => String(c ?? '')).join(' | ')} |\n`;
        }
        if (table.rows > 5) {
          output += `  ... (共 ${table.rows} 行)\n`;
        }
        output += '\n';
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      return { ok: true, output, meta: result as Record<string, unknown> };
    }

    case 'convert_to_docx': {
      const inputPath = params.input_path;
      if (!inputPath) {
        return {
          ok: false,
          error: 'action "convert_to_docx" requires input_path parameter',
          code: 'INVALID_ARGS',
        };
      }

      const resolvedInput = resolveAbs(inputPath, ctx);
      const outputPath = params.output_path
        ? resolveAbs(params.output_path, ctx)
        : undefined;

      const result = await executePythonScript('pdf_tools.py', [
        '--operation',
        'convert_to_docx',
        '--params',
        JSON.stringify({
          input_path: resolvedInput,
          output_path: outputPath,
          start_page: params.start_page,
          end_page: params.end_page,
        }),
      ]);

      if (!result.success) {
        return { ok: false, error: result.error || 'PDF 转 DOCX 失败' };
      }

      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `✅ PDF 已转换为 DOCX！\n\n📄 输入: ${path.basename(resolvedInput)}\n📄 输出: ${result.output_path}\n📦 大小: ${((result.file_size as number) / 1024).toFixed(1)} KB`,
        meta: { ...(result as Record<string, unknown>), outputPath: result.output_path as string },
      };
    }
  }
}

class PdfAutomateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePdfAutomate(args, ctx, canUseTool, onProgress);
  }
}

export const pdfAutomateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PdfAutomateHandler();
  },
};
