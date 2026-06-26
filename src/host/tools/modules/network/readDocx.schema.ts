// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const readDocxSchema: ToolSchema = {
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
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
