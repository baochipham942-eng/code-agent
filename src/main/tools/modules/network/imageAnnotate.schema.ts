// Schema-only file (P0-7 方案 A — single source of truth)
// image_annotate — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const imageAnnotateSchema: ToolSchema = {
  name: 'image_annotate',
  description: `在图片上绘制矩形框标注文字位置，输出带标记的新图片。

**触发关键词**（用户提到这些词时必须使用此工具）：
- "矩形框"、"矩形工具"、"框出"、"画框"、"标记"
- "在图片上标注"、"在截图上画"、"圈出"
- "用框框起来"、"框选"、"标出位置"

**核心能力**：
1. 使用 OCR 精确识别文字位置（百度 OCR API）
2. 在原图上绘制精确的矩形框
3. 输出带标注的新图片文件

**使用场景**：
- 用户发送图片并要求"用矩形框框出文字"
- 用户要求"在截图上标记按钮位置"
- 用户说"框出图片中的XX"

参数：
- image_path: 图片路径
- query: 标注指令，如"用矩形框框出所有文字"
- output_path: 输出路径（可选）
- show_labels: 是否显示序号标签（默认 true）

**需要配置**：
- 百度 OCR API（需要 BAIDU_OCR_API_KEY 和 BAIDU_OCR_SECRET_KEY）
- 或智谱 API Key（降级方案，坐标不精确）`,
  inputSchema: {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: '图片文件路径',
      },
      query: {
        type: 'string',
        description: '分析问题或标注指令',
      },
      output_path: {
        type: 'string',
        description: '标注后的图片保存路径',
      },
      draw_annotations: {
        type: 'boolean',
        description: '是否绘制标注（默认 true）',
        default: true,
      },
      show_labels: {
        type: 'boolean',
        description: '是否显示序号标签（默认 true）',
        default: true,
      },
      stroke_color: {
        type: 'string',
        description: '标注框颜色（默认多彩）',
      },
    },
    required: ['image_path', 'query'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
