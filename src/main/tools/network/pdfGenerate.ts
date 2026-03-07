// ============================================================================
// PDF Generate Tool - 生成 PDF 文档
// 支持 Markdown 内容转换为 PDF
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { createLogger } from '../../services/infra/logger';
import { formatFileSize } from './utils';

const logger = createLogger('PdfGenerate');

interface PdfGenerateParams {
  title: string;
  content: string;
  output_path?: string;
  theme?: 'default' | 'academic' | 'minimal';
  page_size?: 'A4' | 'Letter' | 'Legal';
  author?: string;
}

/**
 * 主题配置
 */
const THEMES = {
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

/**
 * 页面尺寸配置
 */
const PAGE_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
};

/**
 * 解析 Markdown 内容为段落
 */
function parseMarkdown(content: string): Array<{
  type: 'title' | 'heading' | 'subheading' | 'paragraph' | 'list' | 'code' | 'quote';
  text: string;
  items?: string[];
}> {
  const lines = content.split('\n');
  const blocks: Array<{
    type: 'title' | 'heading' | 'subheading' | 'paragraph' | 'list' | 'code' | 'quote';
    text: string;
    items?: string[];
  }> = [];

  let currentList: string[] = [];
  let inCodeBlock = false;
  let codeContent = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 代码块
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

    // 清空当前列表
    if (currentList.length > 0 && !line.match(/^[-*]\s/) && !line.match(/^\d+\.\s/)) {
      blocks.push({ type: 'list', text: '', items: currentList });
      currentList = [];
    }

    // 标题
    if (line.startsWith('# ')) {
      blocks.push({ type: 'title', text: line.substring(2).trim() });
    } else if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', text: line.substring(3).trim() });
    } else if (line.startsWith('### ')) {
      blocks.push({ type: 'subheading', text: line.substring(4).trim() });
    }
    // 列表
    else if (line.match(/^[-*]\s/)) {
      currentList.push(line.replace(/^[-*]\s/, '').trim());
    } else if (line.match(/^\d+\.\s/)) {
      currentList.push(line.replace(/^\d+\.\s/, '').trim());
    }
    // 引用
    else if (line.startsWith('> ')) {
      blocks.push({ type: 'quote', text: line.substring(2).trim() });
    }
    // 普通段落
    else if (line.trim()) {
      // 处理行内格式
      let text = line
        .replace(/\*\*(.+?)\*\*/g, '$1')  // 粗体
        .replace(/\*(.+?)\*/g, '$1')       // 斜体
        .replace(/`(.+?)`/g, '$1')         // 行内代码
        .trim();

      if (text) {
        blocks.push({ type: 'paragraph', text });
      }
    }
  }

  // 处理剩余列表
  if (currentList.length > 0) {
    blocks.push({ type: 'list', text: '', items: currentList });
  }

  return blocks;
}

export const pdfGenerateTool: Tool = {
  name: 'pdf_generate',
  description: `生成 PDF 文档。

支持 Markdown 格式内容：
- 标题（# ## ###）
- 列表（- 或 1.）
- 代码块
- 引用块
- 粗体、斜体

**使用示例：**
\`\`\`
pdf_generate { "title": "项目报告", "content": "# 概述\\n这是一份报告..." }
pdf_generate { "title": "论文", "content": "## 摘要\\n...", "theme": "academic" }
\`\`\`

**主题选项：**
- default: 默认商务风格
- academic: 学术论文风格
- minimal: 简约风格`,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'PDF 标题',
      },
      content: {
        type: 'string',
        description: 'Markdown 格式的内容',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 {title}.pdf）',
      },
      theme: {
        type: 'string',
        enum: ['default', 'academic', 'minimal'],
        description: '主题风格（默认: default）',
        default: 'default',
      },
      page_size: {
        type: 'string',
        enum: ['A4', 'Letter', 'Legal'],
        description: '页面尺寸（默认: A4）',
        default: 'A4',
      },
      author: {
        type: 'string',
        description: '作者名称',
      },
    },
    required: ['title', 'content'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      title,
      content,
      output_path,
      theme = 'default',
      page_size = 'A4',
      author,
    } = params as unknown as PdfGenerateParams;

    try {
      context.emit?.('tool_output', {
        tool: 'pdf_generate',
        message: `📄 正在生成 PDF: ${title}`,
      });

      const themeConfig = THEMES[theme];
      const pageSize = PAGE_SIZES[page_size];

      // 创建 PDF 文档
      const doc = new PDFDocument({
        size: pageSize as [number, number],
        margins: { top: 72, bottom: 72, left: 72, right: 72 },
        info: {
          Title: title,
          Author: author || 'Code Agent',
          Creator: 'Code Agent PDF Generator',
        },
      });

      // 确定输出路径
      const safeTitle = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
      const fileName = `${safeTitle}.pdf`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, fileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 创建写入流
      const writeStream = fs.createWriteStream(finalPath);
      doc.pipe(writeStream);

      // 添加标题
      doc
        .font(themeConfig.fontFamily + '-Bold')
        .fontSize(themeConfig.titleSize)
        .fillColor(themeConfig.titleColor)
        .text(title, { align: 'center' });

      doc.moveDown(1);

      // 添加日期
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

      // 解析并渲染内容
      const blocks = parseMarkdown(content);

      for (const block of blocks) {
        // 检查是否需要换页
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
              .text(block.text, {
                indent: 20,
              });
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

      // 完成文档
      doc.end();

      // 等待写入完成
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const stats = fs.statSync(finalPath);
      const pageCount = doc.bufferedPageRange().count;

      logger.info('PDF generated', { path: finalPath, pages: pageCount, size: stats.size });

      return {
        success: true,
        output: `✅ PDF 文档已生成！

📄 标题: ${title}
🎨 主题: ${theme}
📐 尺寸: ${page_size}
📄 页数: ${pageCount}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}

点击上方路径可直接打开。`,
        metadata: {
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
      logger.error('PDF generation failed', { error: message });
      return {
        success: false,
        error: `PDF 生成失败: ${message}`,
      };
    }
  },
};
