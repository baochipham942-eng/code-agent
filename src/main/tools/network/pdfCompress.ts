// ============================================================================
// PDF Compress Tool - PDF 压缩工具
// 使用 Ghostscript 压缩 PDF 文件
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../services/infra/logger';
import { formatFileSize } from './utils';

const execFileAsync = promisify(execFile);
const logger = createLogger('PdfCompress');

interface PdfCompressParams {
  input_path: string;
  output_path?: string;
  quality?: 'screen' | 'ebook' | 'printer' | 'prepress';
}

/**
 * 查找 Ghostscript 可执行文件
 */
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

const QUALITY_DESCRIPTIONS: Record<string, string> = {
  screen: '最小体积（72 dpi，适合屏幕浏览）',
  ebook: '平衡（150 dpi，适合电子书/邮件）',
  printer: '高质量（300 dpi，适合打印）',
  prepress: '最高质量（300 dpi，适合印刷）',
};

export const pdfCompressTool: Tool = {
  name: 'pdf_compress',
  description: `压缩 PDF 文件，减小文件体积。使用 Ghostscript 引擎。

**质量等级：**
- screen: 最小体积（72 dpi，适合屏幕浏览）
- ebook: 平衡压缩（150 dpi，适合邮件发送，默认）
- printer: 高质量（300 dpi，适合打印）
- prepress: 最高质量（保留印刷所需信息）

**使用示例：**

默认压缩（ebook 质量）：
\`\`\`
pdf_compress { "input_path": "/path/to/large.pdf" }
\`\`\`

最大压缩：
\`\`\`
pdf_compress { "input_path": "/path/to/large.pdf", "quality": "screen" }
\`\`\`

指定输出路径：
\`\`\`
pdf_compress { "input_path": "report.pdf", "output_path": "report_small.pdf", "quality": "ebook" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      input_path: {
        type: 'string',
        description: 'PDF 文件路径',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 原文件名_compressed.pdf）',
      },
      quality: {
        type: 'string',
        enum: ['screen', 'ebook', 'printer', 'prepress'],
        description: '压缩质量等级（默认: ebook）',
        default: 'ebook',
      },
    },
    required: ['input_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      input_path,
      output_path,
      quality = 'ebook',
    } = params as unknown as PdfCompressParams;

    try {
      // 解析输入路径
      const absInputPath = path.isAbsolute(input_path)
        ? input_path
        : path.join(context.workingDirectory, input_path);

      // 检查文件存在
      if (!fs.existsSync(absInputPath)) {
        return {
          success: false,
          error: `文件不存在: ${absInputPath}`,
        };
      }

      // 检查是否为 PDF
      if (!absInputPath.toLowerCase().endsWith('.pdf')) {
        return {
          success: false,
          error: `不是 PDF 文件: ${path.basename(absInputPath)}`,
        };
      }

      const originalSize = fs.statSync(absInputPath).size;

      // 检查 Ghostscript
      const gsPath = await findGhostscript();
      if (!gsPath) {
        return {
          success: false,
          error: `未找到 Ghostscript。请先安装：

macOS:   brew install ghostscript
Ubuntu:  sudo apt-get install ghostscript
Windows: 从 https://www.ghostscript.com 下载安装`,
        };
      }

      context.emit?.('tool_output', {
        tool: 'pdf_compress',
        message: `📄 压缩中: ${path.basename(absInputPath)} (${formatFileSize(originalSize)}) [${quality}]`,
      });

      // 确定输出路径
      const inputDir = path.dirname(absInputPath);
      const inputBaseName = path.basename(absInputPath, '.pdf');
      let absOutputPath: string;

      if (output_path) {
        absOutputPath = path.isAbsolute(output_path)
          ? output_path
          : path.join(context.workingDirectory, output_path);
      } else {
        absOutputPath = path.join(inputDir, `${inputBaseName}_compressed.pdf`);
      }

      // 确保输出目录存在
      const outputDir = path.dirname(absOutputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 使用临时文件避免覆盖问题（输入输出可能相同）
      const tmpPath = absOutputPath + '.tmp';

      // Ghostscript 压缩参数
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

      // 移动临时文件到最终位置
      if (fs.existsSync(tmpPath)) {
        fs.renameSync(tmpPath, absOutputPath);
      }

      const newSize = fs.statSync(absOutputPath).size;
      const reduction = ((1 - newSize / originalSize) * 100).toFixed(1);

      // 如果压缩后反而更大，告知用户
      if (newSize >= originalSize) {
        // 删除无效的输出（如果不是覆盖原文件）
        if (absOutputPath !== absInputPath) {
          fs.unlinkSync(absOutputPath);
        }
        return {
          success: true,
          output: `⚠️ PDF 已经是最优状态，无法进一步压缩。

📄 文件: ${path.basename(absInputPath)}
📦 大小: ${formatFileSize(originalSize)}
💡 提示: 该文件可能已经过压缩或主要包含矢量内容。`,
          metadata: {
            filePath: absInputPath,
            originalSize,
            newSize: originalSize,
            compressionRatio: 0,
          },
        };
      }

      logger.info('PDF compressed', {
        input: absInputPath,
        output: absOutputPath,
        originalSize,
        newSize,
        quality,
        reduction: `${reduction}%`,
      });

      return {
        success: true,
        output: `✅ PDF 压缩完成！

📄 输入: ${path.basename(absInputPath)}
📄 输出: ${path.basename(absOutputPath)}
📦 原始大小: ${formatFileSize(originalSize)}
📦 压缩后: ${formatFileSize(newSize)} (减少 ${reduction}%)
🎯 质量: ${QUALITY_DESCRIPTIONS[quality]}
📂 路径: ${absOutputPath}`,
        metadata: {
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
      logger.error('PDF compression failed', { error: message });
      return {
        success: false,
        error: `PDF 压缩失败: ${message}`,
      };
    }
  },
};
