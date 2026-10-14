// Schema-only file (P0-7 方案 A — single source of truth)
// video_generate — N-MEDIA-GEN-PHASE2 对齐 image 合同：output_file_path（工作区相对）+
// model（默认 MiniMax-Hailuo-02；cogvideox-* 走智谱旧路径）+ image_path（MiniMax 图生视频）。
import type { ToolSchema } from '../../../protocol/tools';

export const videoGenerateSchema: ToolSchema = {
  name: 'video_generate',
  description: `生成 AI 视频，可以根据文字描述或图片生成短视频。

默认走 MiniMax 海螺（文生视频 MiniMax-Hailuo-02；给 image_path 时自动用图生视频模型 I2V-01），固定 6 秒片段；传 cogvideox-* 模型 id 时走智谱 CogVideoX 旧路径（支持横屏/竖屏/方形比例、时长 5 或 10 秒、image_url 图生）。生成需要 30-180 秒。
本工具为按次付费调用：MiniMax 海螺参考单价约 $0.28 / 条（768P · 6 秒默认档，MiniMax 官方价目）；请在用户确有需求时再调用，不要重复试探。`,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '视频描述（支持中英文）',
      },
      model: {
        type: 'string',
        description: '视频模型 id（默认: MiniMax-Hailuo-02 文生视频；给 image_path 时自动用 I2V-01 图生视频；cogvideox-* 走智谱旧路径）',
        default: 'MiniMax-Hailuo-02',
      },
      image_path: {
        type: 'string',
        description: '图生视频起始图片的工作区路径（png/jpg/jpeg/webp，≤10MB；MiniMax 图生视频输入）',
      },
      image_url: {
        type: 'string',
        description: '起始图片 URL（仅 cogvideox-* 模型的图生视频）',
      },
      aspect_ratio: {
        type: 'string',
        enum: ['16:9', '9:16', '1:1'],
        description: '宽高比（默认: 16:9；仅 cogvideox-* 模型生效）',
        default: '16:9',
      },
      quality: {
        type: 'string',
        enum: ['quality', 'speed'],
        description: '质量模式（默认: quality；仅 cogvideox-* 模型生效）',
        default: 'quality',
      },
      duration: {
        type: 'number',
        description: '视频时长秒数，可选 5 或 10（默认: 5；仅 cogvideox-* 模型生效）',
        default: 5,
      },
      fps: {
        type: 'number',
        description: '帧率，可选 30 或 60（默认: 30；仅 cogvideox-* 模型生效）',
        default: 30,
      },
      output_file_path: {
        type: 'string',
        description: '工作区相对保存路径（不填则自动保存到 .code-agent/artifacts/videos/）',
      },
    },
    required: ['prompt'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
