// Schema-only file (P0-7 方案 A — single source of truth)
// video_generate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const videoGenerateSchema: ToolSchema = {
  name: 'video_generate',
  description: `生成 AI 视频，可以根据文字描述或图片生成短视频。

支持横屏、竖屏、方形三种比例，时长 5 秒或 10 秒。生成需要 30-180 秒。`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '视频描述（支持中英文）',
      },
      image_url: {
        type: 'string',
        description: '起始图片 URL（用于图生视频）',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1'],
        description: '宽高比（默认: 16:9）',
        default: '16:9',
      },
      quality: {
        type: 'string',
        enum: ['quality', 'speed'],
        description: '质量模式（默认: quality）',
        default: 'quality',
      },
      duration: {
        type: 'number',
        description: '视频时长秒数，可选 5 或 10（默认: 5）',
        default: 5,
      },
      fps: {
        type: 'number',
        description: '帧率，可选 30 或 60（默认: 30）',
        default: 30,
      },
      output_path: {
        type: 'string',
        description: '保存路径（不填则返回 URL）',
      },
    },
    required: ['prompt'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
