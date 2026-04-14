// ============================================================================
// DOCX Generate Tool - 生成 Word 文档 (.docx)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { formatFileSize } from '../utils/fileSize';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
} from 'docx';

// Word 文档样式主题
type DocxTheme = 'professional' | 'academic' | 'minimal' | 'creative';

interface DocxGenerateParams {
  title: string;
  content: string;
  theme?: DocxTheme;
  output_path?: string;
  author?: string;
}

// 主题配置
const themeConfigs: Record<DocxTheme, {
  titleSize: number;
  headingSize: number;
  textSize: number;
  titleColor: string;
  headingColor: string;
  textColor: string;
  fontFamily: string;
}> = {
  professional: {
    titleSize: 36,
    headingSize: 24,
    textSize: 12,
    titleColor: '1a365d',
    headingColor: '2c5282',
    textColor: '2d3748',
    fontFamily: 'Arial',
  },
  academic: {
    titleSize: 32,
    headingSize: 20,
    textSize: 12,
    titleColor: '000000',
    headingColor: '333333',
    textColor: '000000',
    fontFamily: 'Times New Roman',
  },
  minimal: {
    titleSize: 28,
    headingSize: 18,
    textSize: 11,
    titleColor: '1f2937',
    headingColor: '374151',
    textColor: '4b5563',
    fontFamily: 'Helvetica',
  },
  creative: {
    titleSize: 40,
    headingSize: 26,
    textSize: 12,
    titleColor: '7c3aed',
    headingColor: '6d28d9',
    textColor: '1f2937',
    fontFamily: 'Georgia',
  },
};

/**
 * 解析 Markdown 内容为文档元素
 */
function parseMarkdownToDocElements(
  content: string,
  theme: typeof themeConfigs.professional
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split('\n');

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块处理
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        // 结束代码块
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({
                text: codeBlockContent.join('\n'),
                font: 'Consolas',
                size: 20,
                color: '1f2937',
              }),
            ],
            shading: { fill: 'f3f4f6' },
            spacing: { before: 200, after: 200 },
          })
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // 表格处理
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      // 跳过分隔行
      if (!trimmed.match(/^\|[\s-|]+\|$/)) {
        const cells = trimmed
          .split('|')
          .filter((c) => c.trim())
          .map((c) => c.trim());
        tableRows.push(cells);
      }
      continue;
    } else if (inTable) {
      // 结束表格
      if (tableRows.length > 0) {
        paragraphs.push(...createTable(tableRows, theme));
      }
      tableRows = [];
      inTable = false;
    }

    // 空行
    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: '' }));
      continue;
    }

    // 一级标题
    if (trimmed.startsWith('# ')) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.replace(/^#\s*/, ''),
              bold: true,
              size: theme.headingSize * 2,
              color: theme.headingColor,
              font: theme.fontFamily,
            }),
          ],
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 200 },
        })
      );
      continue;
    }

    // 二级标题
    if (trimmed.startsWith('## ')) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.replace(/^##\s*/, ''),
              bold: true,
              size: theme.headingSize * 2 - 4,
              color: theme.headingColor,
              font: theme.fontFamily,
            }),
          ],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300, after: 150 },
        })
      );
      continue;
    }

    // 三级标题
    if (trimmed.startsWith('### ')) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.replace(/^###\s*/, ''),
              bold: true,
              size: theme.headingSize * 2 - 8,
              color: theme.headingColor,
              font: theme.fontFamily,
            }),
          ],
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 200, after: 100 },
        })
      );
      continue;
    }

    // 无序列表
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.replace(/^[-*]\s*/, ''),
              size: theme.textSize * 2,
              color: theme.textColor,
              font: theme.fontFamily,
            }),
          ],
          bullet: { level: 0 },
          spacing: { before: 50, after: 50 },
        })
      );
      continue;
    }

    // 有序列表
    if (trimmed.match(/^\d+\.\s/)) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.replace(/^\d+\.\s*/, ''),
              size: theme.textSize * 2,
              color: theme.textColor,
              font: theme.fontFamily,
            }),
          ],
          numbering: { reference: 'default-numbering', level: 0 },
          spacing: { before: 50, after: 50 },
        })
      );
      continue;
    }

    // 引用块
    if (trimmed.startsWith('> ')) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed.replace(/^>\s*/, ''),
              italics: true,
              size: theme.textSize * 2,
              color: '6b7280',
              font: theme.fontFamily,
            }),
          ],
          indent: { left: 720 },
          shading: { fill: 'f9fafb' },
          spacing: { before: 100, after: 100 },
        })
      );
      continue;
    }

    // 普通段落 - 处理行内格式
    paragraphs.push(createFormattedParagraph(trimmed, theme));
  }

  // 处理未结束的表格
  if (inTable && tableRows.length > 0) {
    paragraphs.push(...createTable(tableRows, theme));
  }

  return paragraphs;
}

/**
 * 创建格式化段落（处理粗体、斜体、代码等）
 */
function createFormattedParagraph(
  text: string,
  theme: typeof themeConfigs.professional
): Paragraph {
  const runs: TextRun[] = [];

  // 简单处理：解析 **bold**, *italic*, `code`
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);

  for (const part of parts) {
    if (!part) continue;

    if (part.startsWith('**') && part.endsWith('**')) {
      runs.push(
        new TextRun({
          text: part.slice(2, -2),
          bold: true,
          size: theme.textSize * 2,
          color: theme.textColor,
          font: theme.fontFamily,
        })
      );
    } else if (part.startsWith('*') && part.endsWith('*')) {
      runs.push(
        new TextRun({
          text: part.slice(1, -1),
          italics: true,
          size: theme.textSize * 2,
          color: theme.textColor,
          font: theme.fontFamily,
        })
      );
    } else if (part.startsWith('`') && part.endsWith('`')) {
      runs.push(
        new TextRun({
          text: part.slice(1, -1),
          font: 'Consolas',
          size: theme.textSize * 2 - 2,
          color: 'dc2626',
          shading: { fill: 'f3f4f6' },
        })
      );
    } else {
      runs.push(
        new TextRun({
          text: part,
          size: theme.textSize * 2,
          color: theme.textColor,
          font: theme.fontFamily,
        })
      );
    }
  }

  return new Paragraph({
    children: runs,
    spacing: { before: 100, after: 100 },
  });
}

/**
 * 创建表格
 */
function createTable(
  rows: string[][],
  theme: typeof themeConfigs.professional
): Paragraph[] {
  if (rows.length === 0) return [];

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, rowIndex) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: cell,
                      bold: rowIndex === 0,
                      size: theme.textSize * 2,
                      color: theme.textColor,
                      font: theme.fontFamily,
                    }),
                  ],
                }),
              ],
              shading: rowIndex === 0 ? { fill: 'f3f4f6' } : undefined,
              borders: {
                top: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
                bottom: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
                left: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
                right: { style: BorderStyle.SINGLE, size: 1, color: 'e5e7eb' },
              },
            })
        ),
      })
    ),
  });

  return [
    new Paragraph({ text: '' }),
    // @ts-expect-error Table is valid in sections.children
    table,
    new Paragraph({ text: '' }),
  ];
}

export const docxGenerateTool: Tool = {
  name: 'docx_generate',
  description: `生成 Word 文档（.docx 文件）。

支持 Markdown 格式内容，自动转换为 Word 格式：
- 标题（# ## ###）
- 列表（- 或 1.）
- 粗体（**text**）、斜体（*text*）
- 代码（\`code\`）和代码块
- 引用（> text）
- 表格（| col1 | col2 |）

**主题选项：**
- professional: 专业商务风格（蓝色系）
- academic: 学术论文风格（黑白，Times New Roman）
- minimal: 极简风格（灰色系）
- creative: 创意风格（紫色系）

**使用示例：**
\`\`\`
docx_generate { "title": "项目报告", "content": "# 概述\\n这是一份报告..." }
docx_generate { "title": "会议纪要", "content": "## 参会人员\\n- 张三\\n- 李四", "theme": "minimal" }
\`\`\``,
  requiresPermission: true,
  permissionLevel: 'write',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '文档标题',
      },
      content: {
        type: 'string',
        description: '文档内容（支持 Markdown 格式）',
      },
      theme: {
        type: 'string',
        enum: ['professional', 'academic', 'minimal', 'creative'],
        description: '主题风格（默认: professional）',
        default: 'professional',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 document-{timestamp}.docx）',
      },
      author: {
        type: 'string',
        description: '文档作者（默认: Code Agent）',
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
      theme = 'professional',
      output_path,
      author = 'Code Agent',
    } = params as unknown as DocxGenerateParams;

    try {
      const themeConfig = themeConfigs[theme as DocxTheme] || themeConfigs.professional;

      // 确定输出路径
      const timestamp = Date.now();
      const fileName = `document-${timestamp}.docx`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, fileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 解析内容
      const contentParagraphs = parseMarkdownToDocElements(content, themeConfig);

      // 创建文档
      const doc = new Document({
        creator: author,
        title: title,
        description: `Generated by Code Agent`,
        styles: {
          default: {
            document: {
              run: {
                font: themeConfig.fontFamily,
                size: themeConfig.textSize * 2,
              },
            },
          },
        },
        numbering: {
          config: [
            {
              reference: 'default-numbering',
              levels: [
                {
                  level: 0,
                  format: 'decimal',
                  text: '%1.',
                  alignment: AlignmentType.LEFT,
                },
              ],
            },
          ],
        },
        sections: [
          {
            children: [
              // 标题
              new Paragraph({
                children: [
                  new TextRun({
                    text: title,
                    bold: true,
                    size: themeConfig.titleSize * 2,
                    color: themeConfig.titleColor,
                    font: themeConfig.fontFamily,
                  }),
                ],
                alignment: AlignmentType.CENTER,
                spacing: { before: 400, after: 400 },
              }),
              // 内容
              ...contentParagraphs,
            ],
          },
        ],
      });

      // 生成并保存文件
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(finalPath, buffer);

      // 获取文件信息
      const stats = fs.statSync(finalPath);

      return {
        success: true,
        output: `✅ Word 文档已生成！

📄 文件路径: ${finalPath}
🎨 主题风格: ${theme}
📦 文件大小: ${formatFileSize(stats.size)}

点击上方文件路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          theme,
          attachment: {
            id: `docx-${timestamp}`,
            type: 'file',
            category: 'document',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
        },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Word 文档生成失败: ${message}`,
      };
    }
  },
};
