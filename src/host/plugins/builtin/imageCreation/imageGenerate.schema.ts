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
- reference_images: 参考图片工作区路径数组（1-3 张，支持 png/jpg/jpeg/webp；"图1/图2/图3"即数组顺序，在 prompt 里用"图1的裙子穿到图2的模特身上"这样指代；输出比例以最后一张图为准，2-3 张时忽略 aspect_ratio；单张走万相描述编辑，2-3 张走 qwen 多图编辑）
- expand_prompt: 是否使用 LLM 扩展优化 prompt（默认 false）
- aspect_ratio: 宽高比 "1:1" | "16:9" | "9:16" | "4:3" | "3:4"（2-3 张参考图时忽略，比例跟随最后一张参考图）
- output_file_path: 工作区相对保存路径（多张图片会在扩展名前加 -1 至 -N；不填则自动保存到 .code-agent/artifacts/images）
- style: 风格 "photo" | "illustration" | "3d" | "anime"

示例：
\`\`\`
image_generate { "prompt": ["一只猫", "一只狗"], "expand_prompt": true }
image_generate { "prompt": ["产品展示图"], "output_file_path": "./product.png", "style": "photo" }
image_generate { "prompt": ["把图1的裙子穿到图2模特身上，保持图2的姿势和背景"], "reference_images": ["dress.png", "model.png"] }
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
        minItems: 1,
        maxItems: 3,
        description: '参考图片工作区路径数组（1-3 张，支持 png/jpg/jpeg/webp；图1/图2/图3 即数组顺序；输出比例以最后一张图为准，2-3 张时忽略 aspect_ratio）',
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
