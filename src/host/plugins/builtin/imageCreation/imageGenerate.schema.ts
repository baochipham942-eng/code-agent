// Schema-only file (P0-7 方案 A — single source of truth)
// image_generate — batch image generation contract
import type { ToolSchema } from '../../../protocol/tools';

export const imageGenerateSchema: ToolSchema = {
  name: 'image_generate',
  description: `生成 AI 图片。
- 优先 CogView-4（智谱，中文原生，快速稳定）
- 备选 FLUX.2（OpenRouter，英文优化）
- 支持中文 prompt 自动扩展优化

参数：
- prompt: 图片描述数组（1 至 10 条，一条一张，支持中英文）
- reference_images: 参考图片工作区路径数组（最多 4 张，支持 png/jpg/jpeg/webp）
- expand_prompt: 是否使用 LLM 扩展优化 prompt（默认 false）
- aspect_ratio: 宽高比 "1:1" | "16:9" | "9:16" | "4:3" | "3:4"
- output_file_path: 工作区相对保存路径（多张图片会在扩展名前加 -1 至 -N；不填则自动保存到 .code-agent/artifacts/images）
- style: 风格 "photo" | "illustration" | "3d" | "anime"

示例：
\`\`\`
image_generate { "prompt": ["一只猫", "一只狗"], "expand_prompt": true }
image_generate { "prompt": ["产品展示图"], "output_file_path": "./product.png", "style": "photo" }
\`\`\``,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'array',
        items: { type: 'string' },
        description: '图片描述数组（1 至 10 条，一条一张，支持中英文）',
      },
      reference_images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图片工作区路径数组（最多 4 张，支持 png/jpg/jpeg/webp）',
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
      output_file_path: {
        type: 'string',
        description: '工作区相对保存路径（多张图片会在扩展名前加 -1 至 -N；不填则自动保存到 .code-agent/artifacts/images）',
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
