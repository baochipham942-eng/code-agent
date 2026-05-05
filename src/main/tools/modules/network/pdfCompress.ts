// ============================================================================
// pdf_compress (P1 Wave 4 D2b — network/document_generation: native ToolModule)
//
// 把 legacy PdfCompressTool（Ghostscript 命令行调用）整体迁移到 native。
// 4 quality 等级 + 临时文件保护（输入输出可能相同时不被破坏）。
//
// 行为保真：legacy 中文文案、emoji（📄 ✅ ⚠️ 📦 🎯 📂 💡）、metadata.attachment
// 形状（id 前缀 pdf-）1:1 复刻。
// 暴露 executePdfCompress 给 modules/network/pdfAutomate dispatcher 复用。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { formatFileSize } from '../../utils/fileSize';
import { pdfCompressSchema as schema } from './pdfCompress.schema';

const execFileAsync = promisify(execFile);

type PdfQuality = 'screen' | 'ebook' | 'printer' | 'prepress';

interface PdfCompressParams {
  input_path: string;
  output_path?: string;
  quality?: PdfQuality;
}

const QUALITY_DESCRIPTIONS: Record<PdfQuality, string> = {
  screen: '最小体积（72 dpi，适合屏幕浏览）',
  ebook: '平衡（150 dpi，适合电子书/邮件）',
  printer: '高质量（300 dpi，适合打印）',
  prepress: '最高质量（300 dpi，适合印刷）',
};

const VALID_QUALITIES: PdfQuality[] = ['screen', 'ebook', 'printer', 'prepress'];

async function findGhostscript(): Promise<string | null> {
  const candidates = ['gs', '/opt/homebrew/bin/gs', '/usr/local/bin/gs', '/usr/bin/gs'];
  for (const cmd of candidates) {
    try {
      await execFileAsync(cmd, ['--version']);
      return cmd;
    } catch {
      // continue
    }
  }
  return null;
}

export async function executePdfCompress(
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

  const params = args as unknown as PdfCompressParams;
  const { input_path } = params;

  if (typeof input_path !== 'string' || input_path.length === 0) {
    return { ok: false, error: 'input_path is required and must be a string', code: 'INVALID_ARGS' };
  }

  const quality: PdfQuality = (params.quality ?? 'ebook') as PdfQuality;
  if (!VALID_QUALITIES.includes(quality)) {
    return {
      ok: false,
      error: `quality must be one of: ${VALID_QUALITIES.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  const output_path = params.output_path;

  try {
    const absInputPath = path.isAbsolute(input_path)
      ? input_path
      : path.join(ctx.workingDir, input_path);

    if (!fs.existsSync(absInputPath)) {
      return { ok: false, error: `文件不存在: ${absInputPath}` };
    }

    if (!absInputPath.toLowerCase().endsWith('.pdf')) {
      return { ok: false, error: `不是 PDF 文件: ${path.basename(absInputPath)}` };
    }

    const originalSize = fs.statSync(absInputPath).size;

    const gsPath = await findGhostscript();
    if (!gsPath) {
      return {
        ok: false,
        error: `未找到 Ghostscript。请先安装：

macOS:   brew install ghostscript
Ubuntu:  sudo apt-get install ghostscript
Windows: 从 https://www.ghostscript.com 下载安装`,
      };
    }

    const inputDir = path.dirname(absInputPath);
    const inputBaseName = path.basename(absInputPath, '.pdf');
    let absOutputPath: string;

    if (output_path) {
      absOutputPath = path.isAbsolute(output_path)
        ? output_path
        : path.join(ctx.workingDir, output_path);
    } else {
      absOutputPath = path.join(inputDir, `${inputBaseName}_compressed.pdf`);
    }

    const outputDir = path.dirname(absOutputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const tmpPath = absOutputPath + '.tmp';

    const gsArgs = [
      '-sDEVICE=pdfwrite',
      `-dPDFSETTINGS=/${quality}`,
      '-dNOPAUSE',
      '-dBATCH',
      '-dQUIET',
      '-dCompatibilityLevel=1.5',
      '-dCompressFonts=true',
      '-dSubsetFonts=true',
      '-dColorImageDownsampleType=/Bicubic',
      '-dGrayImageDownsampleType=/Bicubic',
      `-sOutputFile=${tmpPath}`,
      absInputPath,
    ];

    await execFileAsync(gsPath, gsArgs, { timeout: 120000 });

    if (fs.existsSync(tmpPath)) {
      fs.renameSync(tmpPath, absOutputPath);
    }

    const newSize = fs.statSync(absOutputPath).size;
    const reduction = ((1 - newSize / originalSize) * 100).toFixed(1);

    if (newSize >= originalSize) {
      if (absOutputPath !== absInputPath) {
        fs.unlinkSync(absOutputPath);
      }
      onProgress?.({ stage: 'completing', percent: 100 });
      return {
        ok: true,
        output: `⚠️ PDF 已经是最优状态，无法进一步压缩。

📄 文件: ${path.basename(absInputPath)}
📦 大小: ${formatFileSize(originalSize)}
💡 提示: 该文件可能已经过压缩或主要包含矢量内容。`,
        meta: {
          filePath: absInputPath,
          originalSize,
          newSize: originalSize,
          compressionRatio: 0,
        },
      };
    }

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('PDF compressed', {
      input: absInputPath,
      output: absOutputPath,
      originalSize,
      newSize,
      quality,
      reduction: `${reduction}%`,
    });

    return {
      ok: true,
      output: `✅ PDF 压缩完成！

📄 输入: ${path.basename(absInputPath)}
📄 输出: ${path.basename(absOutputPath)}
📦 原始大小: ${formatFileSize(originalSize)}
📦 压缩后: ${formatFileSize(newSize)} (减少 ${reduction}%)
🎯 质量: ${QUALITY_DESCRIPTIONS[quality]}
📂 路径: ${absOutputPath}`,
      meta: {
        filePath: absOutputPath,
        fileName: path.basename(absOutputPath),
        fileSize: newSize,
        originalSize,
        quality,
        compressionRatio: Number(reduction),
        attachment: {
          id: `pdf-${Date.now()}`,
          type: 'file',
          category: 'document',
          name: path.basename(absOutputPath),
          path: absOutputPath,
          mimeType: 'application/pdf',
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('PDF compression failed', { error: message });
    return { ok: false, error: `PDF 压缩失败: ${message}` };
  }
}

class PdfCompressHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePdfCompress(args, ctx, canUseTool, onProgress);
  }
}

export const pdfCompressModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PdfCompressHandler();
  },
};
