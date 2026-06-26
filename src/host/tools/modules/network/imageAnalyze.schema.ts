// Schema-only file (P0-7 方案 A — single source of truth)
// image_analyze — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const imageAnalyzeSchema: ToolSchema = {
  name: 'image_analyze',
  description: `图片内容分析工具 - 只分析描述，不修改图片。

**核心能力**：理解图片内容并返回文字描述或 JSON 数据，不会在图片上画任何标记。

**适用场景**：
- 描述图片内容、识别物体
- 提取图片中的文字（OCR，返回文本）
- 批量筛选符合条件的图片
- 回答关于图片的问题

**与 image_annotate 的区别**：
- image_analyze：只返回分析结果（文字/JSON），不修改图片
- image_annotate：在图片上画框标注，输出新图片文件

⚠️ 如果用户要求"框出"、"圈出"、"标记"、"画框"，应使用 image_annotate 而非本工具。

## 单图分析模式
参数：
- path: 图片路径（必填）
- prompt: 分析提示（可选，默认"描述图片内容"）
- detail: 图片精度 "low"(默认) | "high"

示例：
\`\`\`
image_analyze { "path": "photo.jpg", "prompt": "这张图片里有什么动物？" }
image_analyze { "path": "screenshot.png", "prompt": "提取图片中的所有文字" }
\`\`\`

## 批量筛选模式
参数：
- paths: 图片路径数组，支持 glob 模式（必填）
- filter: 筛选条件（必填）

示例：
\`\`\`
image_analyze { "paths": ["/Users/xxx/Photos/*.jpg"], "filter": "有猫的照片" }
\`\`\`

## 成本估算
- 100 张图片 ≈ $0.001（几乎免费）`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '单张图片路径（单图模式）',
      },
      prompt: {
        type: 'string',
        description: '分析提示（单图模式，默认"描述图片内容"）',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '图片路径数组，支持 glob 模式（批量模式）',
      },
      filter: {
        type: 'string',
        description: '筛选条件（批量模式）',
      },
      detail: {
        type: 'string',
        enum: ['low', 'high'],
        description: '图片精度：low(默认,更便宜) | high(更准确)',
        default: 'low',
      },
    },
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
