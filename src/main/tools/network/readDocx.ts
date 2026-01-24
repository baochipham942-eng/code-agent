// ============================================================================
// Read DOCX Tool - 读取 Word 文档内容
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import mammoth from 'mammoth';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ReadDocx');

interface ReadDocxParams {
  file_path: string;
  format?: 'text' | 'markdown' | 'html';
}

export const readDocxTool: Tool = {
  name: 'read_docx',
  description: `读取 Word 文档（.docx）的内容。

支持输出格式：
- text: 纯文本（默认）
- markdown: Markdown 格式（保留标题、列表等）
- html: HTML 格式

**使用示例：**
\`\`\`
read_docx { "file_path": "report.docx" }
read_docx { "file_path": "report.docx", "format": "markdown" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Word 文档路径',
      },
      format: {
        type: 'string',
        enum: ['text', 'markdown', 'html'],
        description: '输出格式（默认: text）',
        default: 'text',
      },
    },
    required: ['file_path'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      file_path,
      format = 'text',
    } = params as unknown as ReadDocxParams;

    try {
      // 解析路径
      const absPath = path.isAbsolute(file_path)
        ? file_path
        : path.join(context.workingDirectory, file_path);

      // 检查文件存在
      if (!fs.existsSync(absPath)) {
        return {
          success: false,
          error: `文件不存在: ${absPath}`,
        };
      }

      // 检查扩展名
      const ext = path.extname(absPath).toLowerCase();
      if (ext !== '.docx') {
        return {
          success: false,
          error: `不支持的文件格式: ${ext}，仅支持 .docx`,
        };
      }

      context.emit?.('tool_output', {
        tool: 'read_docx',
        message: `📄 正在读取: ${path.basename(absPath)}`,
      });

      // 读取文档
      const buffer = fs.readFileSync(absPath);
      let result: string;
      let messages: string[] = [];

      if (format === 'html') {
        const extracted = await mammoth.convertToHtml({ buffer });
        result = extracted.value;
        messages = extracted.messages.map((m: any) => m.message);
      } else if (format === 'markdown') {
        // mammoth 不直接支持 markdown，使用 html 后转换
        const extracted = await mammoth.convertToHtml({ buffer });
        // 简单的 HTML to Markdown 转换
        result = extracted.value
          .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
          .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
          .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
          .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
          .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
          .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
          .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
          .replace(/<[^>]+>/g, '')
          .trim();
        messages = extracted.messages.map((m: any) => m.message);
      } else {
        const extracted = await mammoth.extractRawText({ buffer });
        result = extracted.value;
        messages = extracted.messages.map((m: any) => m.message);
      }

      // 统计信息
      const charCount = result.length;
      const wordCount = result.split(/\s+/).filter(w => w).length;
      const lineCount = result.split('\n').length;

      logger.info('DOCX read', { path: absPath, format, charCount });

      let output = `📄 Word 文档内容 (${path.basename(absPath)})\n`;
      output += `格式: ${format} | 字符: ${charCount} | 词数: ${wordCount} | 行数: ${lineCount}\n`;
      output += `${'─'.repeat(50)}\n\n`;
      output += result;

      if (messages.length > 0) {
        output += `\n\n⚠️ 警告信息:\n${messages.join('\n')}`;
      }

      return {
        success: true,
        output,
        metadata: {
          filePath: absPath,
          format,
          charCount,
          wordCount,
          lineCount,
        },
      };
    } catch (error: any) {
      logger.error('DOCX read failed', { error: error.message });
      return {
        success: false,
        error: `Word 文档读取失败: ${error.message}`,
      };
    }
  },
};
