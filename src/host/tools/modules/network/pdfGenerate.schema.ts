// Schema-only file (P0-7 方案 A — single source of truth)
// pdf_generate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const pdfGenerateSchema: ToolSchema = {
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
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
