// Schema-only file (P0-7 方案 A — single source of truth)
// image_process — 字段与 legacy inputSchema 1:1 复刻
//
// 文件位置说明：P2 剥离首发，由 `src/main/tools/modules/network/` 迁入
// `src/main/plugins/builtin/imageProcess/`，作为首个 builtin plugin 验证
// PluginAPI v2 框架。工具名 `image_process` 保持不变（opt-out 前缀）。
import type { ToolSchema } from '../../../protocol/tools';

export const imageProcessSchema: ToolSchema = {
  name: 'image_process',
  description: `图片处理工具，支持格式转换、压缩、缩放。

**操作类型：**
- convert: 格式转换（PNG/JPG/WebP/AVIF/GIF）
- compress: 无损或有损压缩
- resize: 缩放到指定尺寸
- upscale: 放大图片（使用 Lanczos 算法）

**使用示例：**

格式转换：
\`\`\`
image_process { "input_path": "photo.png", "action": "convert", "format": "webp" }
\`\`\`

图片压缩：
\`\`\`
image_process { "input_path": "photo.jpg", "action": "compress", "quality": 80 }
\`\`\`

缩放图片：
\`\`\`
image_process { "input_path": "photo.png", "action": "resize", "width": 800, "height": 600 }
\`\`\`

放大图片（2倍）：
\`\`\`
image_process { "input_path": "icon.png", "action": "upscale", "scale": 2 }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      input_path: {
        type: 'string',
        description: '输入图片路径',
      },
      action: {
        type: 'string',
        enum: ['convert', 'compress', 'resize', 'upscale'],
        description: '操作类型',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 自动生成）',
      },
      format: {
        type: 'string',
        enum: ['png', 'jpg', 'webp', 'avif', 'gif'],
        description: '输出格式（convert 操作必填）',
      },
      quality: {
        type: 'number',
        description: '压缩质量 1-100（默认: 80）',
        default: 80,
      },
      width: {
        type: 'number',
        description: '目标宽度（resize 操作）',
      },
      height: {
        type: 'number',
        description: '目标高度（resize 操作）',
      },
      scale: {
        type: 'number',
        description: '放大倍数（upscale 操作，默认: 2）',
        default: 2,
      },
    },
    required: ['input_path', 'action'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
