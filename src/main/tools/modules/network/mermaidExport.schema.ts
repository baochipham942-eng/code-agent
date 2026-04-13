// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const mermaidExportSchema: ToolSchema = {
  name: 'mermaid_export',
  description: `将 Mermaid 图表代码导出为 PNG 或 SVG 图片。

支持的图表类型：
- 流程图 (graph/flowchart)
- 时序图 (sequenceDiagram)
- 类图 (classDiagram)
- 状态图 (stateDiagram)
- ER 图 (erDiagram)
- 甘特图 (gantt)
- 饼图 (pie)
- 用户旅程图 (journey)
- Git 分支图 (gitGraph)
- 思维导图 (mindmap)
- 时间线 (timeline)

**使用示例：**

流程图：
\`\`\`
mermaid_export {
  "code": "graph TD\\n    A[开始] --> B{判断}\\n    B -->|是| C[结束]\\n    B -->|否| A",
  "format": "png"
}
\`\`\`

时序图：
\`\`\`
mermaid_export {
  "code": "sequenceDiagram\\n    Alice->>Bob: Hello\\n    Bob-->>Alice: Hi!",
  "format": "svg",
  "theme": "dark"
}
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'Mermaid 图表代码',
      },
      format: {
        type: 'string',
        enum: ['png', 'svg'],
        description: '输出格式（默认: png）',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 mermaid-{timestamp}.{format}）',
      },
      theme: {
        type: 'string',
        enum: ['default', 'dark', 'forest', 'neutral'],
        description: '主题风格（默认: default）',
      },
      background: {
        type: 'string',
        description: '背景颜色（默认: transparent 透明）',
      },
      scale: {
        type: 'number',
        description: '缩放比例（默认: 2，仅 PNG 有效）',
      },
    },
    required: ['code'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
