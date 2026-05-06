// Schema-only file (P0-7 方案 A — single source of truth)
// pdf_compress — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const pdfCompressSchema: ToolSchema = {
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
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
