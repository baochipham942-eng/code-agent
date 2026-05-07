// ============================================================================
// docx_generate (P1 Wave 4 D2b — network/document_generation: native ToolModule)
//
// 把 legacy DocxGenerateTool 的 Markdown→docx 渲染管线整体搬到 native：
// 标题 / 列表 / 粗体斜体 / 代码 / 引用 / 表格 + 4 主题（professional/academic/minimal/creative）。
//
// 行为保真：legacy 输出文案、emoji、metadata.attachment 形状 1:1 复刻（评测集依赖）。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
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
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { formatFileSize } from '../../utils/fileSize';
import { createFileArtifact } from '../../artifacts/artifactMeta';
import { docxGenerateSchema as schema } from './docxGenerate.schema';

type DocxTheme = 'professional' | 'academic' | 'minimal' | 'creative';

interface DocxGenerateParams {
  title: string;
  content: string;
  theme?: DocxTheme;
  output_path?: string;
  author?: string;
}

interface ThemeConfig {
  titleSize: number;
  headingSize: number;
  textSize: number;
  titleColor: string;
  headingColor: string;
  textColor: string;
  fontFamily: string;
}

const themeConfigs: Record<DocxTheme, ThemeConfig> = {
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

function parseMarkdownToDocElements(content: string, theme: ThemeConfig): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split('\n');

  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
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
          }),
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

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      if (!trimmed.match(/^\|[\s-|]+\|$/)) {
        const cells = trimmed.split('|').filter((c) => c.trim()).map((c) => c.trim());
        tableRows.push(cells);
      }
      continue;
    } else if (inTable) {
      if (tableRows.length > 0) {
        paragraphs.push(...createTable(tableRows, theme));
      }
      tableRows = [];
      inTable = false;
    }

    if (!trimmed) {
      paragraphs.push(new Paragraph({ text: '' }));
      continue;
    }

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
        }),
      );
      continue;
    }

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
        }),
      );
      continue;
    }

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
        }),
      );
      continue;
    }

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
        }),
      );
      continue;
    }

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
        }),
      );
      continue;
    }

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
        }),
      );
      continue;
    }

    paragraphs.push(createFormattedParagraph(trimmed, theme));
  }

  if (inTable && tableRows.length > 0) {
    paragraphs.push(...createTable(tableRows, theme));
  }

  return paragraphs;
}

function createFormattedParagraph(text: string, theme: ThemeConfig): Paragraph {
  const runs: TextRun[] = [];
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
        }),
      );
    } else if (part.startsWith('*') && part.endsWith('*')) {
      runs.push(
        new TextRun({
          text: part.slice(1, -1),
          italics: true,
          size: theme.textSize * 2,
          color: theme.textColor,
          font: theme.fontFamily,
        }),
      );
    } else if (part.startsWith('`') && part.endsWith('`')) {
      runs.push(
        new TextRun({
          text: part.slice(1, -1),
          font: 'Consolas',
          size: theme.textSize * 2 - 2,
          color: 'dc2626',
          shading: { fill: 'f3f4f6' },
        }),
      );
    } else {
      runs.push(
        new TextRun({
          text: part,
          size: theme.textSize * 2,
          color: theme.textColor,
          font: theme.fontFamily,
        }),
      );
    }
  }

  return new Paragraph({
    children: runs,
    spacing: { before: 100, after: 100 },
  });
}

function createTable(rows: string[][], theme: ThemeConfig): Paragraph[] {
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
            }),
        ),
      }),
    ),
  });

  return [
    new Paragraph({ text: '' }),
    // @ts-expect-error Table is valid in sections.children
    table,
    new Paragraph({ text: '' }),
  ];
}

export async function executeDocxGenerate(
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

  const params = args as unknown as DocxGenerateParams;
  const { title, content } = params;

  if (typeof title !== 'string' || title.length === 0) {
    return { ok: false, error: 'title is required and must be a string', code: 'INVALID_ARGS' };
  }
  if (typeof content !== 'string') {
    return { ok: false, error: 'content is required and must be a string', code: 'INVALID_ARGS' };
  }

  const theme: DocxTheme = (params.theme ?? 'professional') as DocxTheme;
  const author = params.author ?? 'Code Agent';
  const output_path = params.output_path;

  try {
    const themeConfig = themeConfigs[theme] || themeConfigs.professional;

    const timestamp = Date.now();
    const fileName = `document-${timestamp}.docx`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const contentParagraphs = parseMarkdownToDocElements(content, themeConfig);

    const doc = new Document({
      creator: author,
      title,
      description: 'Generated by Code Agent',
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
            ...contentParagraphs,
          ],
        },
      ],
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(finalPath, buffer);

    const stats = fs.statSync(finalPath);

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('docx_generate done', { path: finalPath, size: stats.size });

    return {
      ok: true,
      output: `✅ Word 文档已生成！

📄 文件路径: ${finalPath}
🎨 主题风格: ${theme}
📦 文件大小: ${formatFileSize(stats.size)}

点击上方文件路径可直接打开。`,
      meta: {
        artifact: await createFileArtifact(finalPath, schema.name, ctx, {
          kind: 'document',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: stats.size,
          metadata: {
            title,
            theme,
            author,
          },
        }),
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
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Word 文档生成失败: ${message}` };
  }
}

class DocxGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeDocxGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const docxGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new DocxGenerateHandler();
  },
};
