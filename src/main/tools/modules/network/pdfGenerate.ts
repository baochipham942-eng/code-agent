// ============================================================================
// pdf_generate (P1 Wave 4 D2b — network/document_generation: native ToolModule)
//
// 把 legacy PdfGenerateTool 的 Markdown→PDF 渲染管线（pdfkit 流写入 +
// 3 主题（default/academic/minimal）+ 3 页面尺寸（A4/Letter/Legal））迁移到 native。
//
// 行为保真：legacy 输出文案、emoji（✅ 📄 🎨 📐 📦）、metadata.attachment 形状
// （id 前缀 pdf-、mimeType=application/pdf、category=document）1:1 复刻。
// 暴露 executePdfGenerate 给 modules/network/pdfAutomate dispatcher 复用。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { formatFileSize } from '../../utils/fileSize';
import { pdfGenerateSchema as schema } from './pdfGenerate.schema';

type PdfTheme = 'default' | 'academic' | 'minimal';
type PdfPageSize = 'A4' | 'Letter' | 'Legal';

interface PdfGenerateParams {
  title: string;
  content: string;
  output_path?: string;
  theme?: PdfTheme;
  page_size?: PdfPageSize;
  author?: string;
}

interface ThemeConfig {
  titleSize: number;
  headingSize: number;
  subheadingSize: number;
  bodySize: number;
  titleColor: string;
  headingColor: string;
  bodyColor: string;
  accentColor: string;
  fontFamily: string;
}

const THEMES: Record<PdfTheme, ThemeConfig> = {
  default: {
    titleSize: 24,
    headingSize: 18,
    subheadingSize: 14,
    bodySize: 12,
    titleColor: '#1a1a1a',
    headingColor: '#2c3e50',
    bodyColor: '#333333',
    accentColor: '#3498db',
    fontFamily: 'Helvetica',
  },
  academic: {
    titleSize: 20,
    headingSize: 16,
    subheadingSize: 13,
    bodySize: 11,
    titleColor: '#000000',
    headingColor: '#1a1a1a',
    bodyColor: '#1a1a1a',
    accentColor: '#2c3e50',
    fontFamily: 'Times-Roman',
  },
  minimal: {
    titleSize: 22,
    headingSize: 16,
    subheadingSize: 13,
    bodySize: 11,
    titleColor: '#2c3e50',
    headingColor: '#34495e',
    bodyColor: '#4a4a4a',
    accentColor: '#7f8c8d',
    fontFamily: 'Helvetica',
  },
};

const PAGE_SIZES: Record<PdfPageSize, [number, number]> = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
};

interface MarkdownBlock {
  type: 'title' | 'heading' | 'subheading' | 'paragraph' | 'list' | 'code' | 'quote';
  text: string;
  items?: string[];
}

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];

  let currentList: string[] = [];
  let inCodeBlock = false;
  let codeContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inCodeBlock) {
        blocks.push({ type: 'code', text: codeContent.trim() });
        codeContent = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeContent += line + '\n';
      continue;
    }

    if (currentList.length > 0 && !line.match(/^[-*]\s/) && !line.match(/^\d+\.\s/)) {
      blocks.push({ type: 'list', text: '', items: currentList });
      currentList = [];
    }

    if (line.startsWith('# ')) {
      blocks.push({ type: 'title', text: line.substring(2).trim() });
    } else if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', text: line.substring(3).trim() });
    } else if (line.startsWith('### ')) {
      blocks.push({ type: 'subheading', text: line.substring(4).trim() });
    } else if (line.match(/^[-*]\s/)) {
      currentList.push(line.replace(/^[-*]\s/, '').trim());
    } else if (line.match(/^\d+\.\s/)) {
      currentList.push(line.replace(/^\d+\.\s/, '').trim());
    } else if (line.startsWith('> ')) {
      blocks.push({ type: 'quote', text: line.substring(2).trim() });
    } else if (line.trim()) {
      const text = line
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*(.+?)\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .trim();
      if (text) {
        blocks.push({ type: 'paragraph', text });
      }
    }
  }

  if (currentList.length > 0) {
    blocks.push({ type: 'list', text: '', items: currentList });
  }

  return blocks;
}

export async function executePdfGenerate(
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

  const params = args as unknown as PdfGenerateParams;
  const { title, content } = params;

  if (typeof title !== 'string' || title.length === 0) {
    return { ok: false, error: 'title is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'content is required and must be a string', code: 'INVALID_ARGS' };
  }

  const theme: PdfTheme = (params.theme ?? 'default') as PdfTheme;
  const page_size: PdfPageSize = (params.page_size ?? 'A4') as PdfPageSize;
  const author = params.author;
  const output_path = params.output_path;

  try {
    const themeConfig = THEMES[theme] ?? THEMES.default;
    const pageSize = PAGE_SIZES[page_size] ?? PAGE_SIZES.A4;

    const doc = new PDFDocument({
      size: pageSize,
      margins: { top: 72, bottom: 72, left: 72, right: 72 },
      info: {
        Title: title,
        Author: author || 'Code Agent',
        Creator: 'Code Agent PDF Generator',
      },
    });

    const safeTitle = title.replace(/[^a-zA-Z0-9一-龥]/g, '_');
    const fileName = `${safeTitle}.pdf`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const writeStream = fs.createWriteStream(finalPath);
    doc.pipe(writeStream);

    doc
      .font(themeConfig.fontFamily + '-Bold')
      .fontSize(themeConfig.titleSize)
      .fillColor(themeConfig.titleColor)
      .text(title, { align: 'center' });

    doc.moveDown(1);

    const date = new Date().toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    doc
      .font(themeConfig.fontFamily)
      .fontSize(themeConfig.bodySize)
      .fillColor(themeConfig.accentColor)
      .text(date, { align: 'center' });

    if (author) {
      doc.text(`作者: ${author}`, { align: 'center' });
    }

    doc.moveDown(2);

    const blocks = parseMarkdown(content);

    for (const block of blocks) {
      if (doc.y > pageSize[1] - 100) {
        doc.addPage();
      }

      switch (block.type) {
        case 'title':
          doc
            .font(themeConfig.fontFamily + '-Bold')
            .fontSize(themeConfig.headingSize)
            .fillColor(themeConfig.headingColor)
            .text(block.text);
          doc.moveDown(0.5);
          break;

        case 'heading':
          doc.moveDown(0.5);
          doc
            .font(themeConfig.fontFamily + '-Bold')
            .fontSize(themeConfig.headingSize)
            .fillColor(themeConfig.headingColor)
            .text(block.text);
          doc.moveDown(0.3);
          break;

        case 'subheading':
          doc.moveDown(0.3);
          doc
            .font(themeConfig.fontFamily + '-Bold')
            .fontSize(themeConfig.subheadingSize)
            .fillColor(themeConfig.headingColor)
            .text(block.text);
          doc.moveDown(0.2);
          break;

        case 'paragraph':
          doc
            .font(themeConfig.fontFamily)
            .fontSize(themeConfig.bodySize)
            .fillColor(themeConfig.bodyColor)
            .text(block.text, { align: 'justify' });
          doc.moveDown(0.5);
          break;

        case 'list':
          doc.font(themeConfig.fontFamily).fontSize(themeConfig.bodySize);
          if (block.items) {
            for (const item of block.items) {
              doc
                .fillColor(themeConfig.accentColor)
                .text('• ', { continued: true })
                .fillColor(themeConfig.bodyColor)
                .text(item);
            }
          }
          doc.moveDown(0.5);
          break;

        case 'code':
          doc
            .font('Courier')
            .fontSize(themeConfig.bodySize - 1)
            .fillColor('#2c3e50')
            .text(block.text, { indent: 20 });
          doc.moveDown(0.5);
          break;

        case 'quote':
          doc
            .font(themeConfig.fontFamily + '-Oblique')
            .fontSize(themeConfig.bodySize)
            .fillColor(themeConfig.accentColor)
            .text(`"${block.text}"`, { indent: 20 });
          doc.moveDown(0.5);
          break;
      }
    }

    doc.end();

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
    });

    const stats = fs.statSync(finalPath);
    const pageCount = doc.bufferedPageRange().count;

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('pdf_generate done', { path: finalPath, pages: pageCount, size: stats.size });

    return {
      ok: true,
      output: `✅ PDF 文档已生成！

📄 标题: ${title}
🎨 主题: ${theme}
📐 尺寸: ${page_size}
📄 页数: ${pageCount}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`,
      meta: {
        filePath: finalPath,
        fileName: path.basename(finalPath),
        fileSize: stats.size,
        pageCount,
        theme,
        pageSize: page_size,
        attachment: {
          id: `pdf-${Date.now()}`,
          type: 'file',
          category: 'document',
          name: path.basename(finalPath),
          path: finalPath,
          size: stats.size,
          mimeType: 'application/pdf',
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('PDF generation failed', { error: message });
    return { ok: false, error: `PDF 生成失败: ${message}` };
  }
}

class PdfGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executePdfGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const pdfGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new PdfGenerateHandler();
  },
};
