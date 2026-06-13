// Schema-only file (P0-7 方案 A — single source of truth)
// image_generate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const imageGenerateSchema: ToolSchema = {
  name: 'image_generate',
  description: `生成 AI 图片。
- 优先 CogView-4（智谱，中文原生，快速稳定）
- 备选 FLUX.2（OpenRouter，英文优化）
- 支持中文 prompt 自动扩展优化

参数：
- prompt: 图片描述（支持中英文）
- expand_prompt: 是否使用 LLM 扩展优化 prompt（默认 false）
- aspect_ratio: 宽高比 "1:1" | "16:9" | "9:16" | "4:3" | "3:4"
- output_path: 保存路径（不填则自动保存到 .code-agent/artifacts/images）
- style: 风格 "photo" | "illustration" | "3d" | "anime"

示例：
\`\`\`
image_generate { "prompt": "一只猫", "expand_prompt": true }
image_generate { "prompt": "产品展示图", "output_path": "./product.png", "style": "photo" }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '图片描述（支持中英文）',
      },
      expand_prompt: {
        type: 'boolean',
        description: '是否使用 LLM 扩展 prompt（默认: false）',
        default: false,
      },
      aspect_ratio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: '宽高比（默认: 1:1）',
        default: '1:1',
      },
      output_path: {
        type: 'string',
        description: '保存路径（不填则自动保存到 .code-agent/artifacts/images）',
      },
      style: {
        type: 'string',
        enum: ['photo', 'illustration', '3d', 'anime'],
        description: '风格提示',
      },
    },
    required: ['prompt'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
