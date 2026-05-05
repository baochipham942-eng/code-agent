// Schema-only file (P0-7 方案 A — single source of truth)
// docx_generate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const docxGenerateSchema: ToolSchema = {
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
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
