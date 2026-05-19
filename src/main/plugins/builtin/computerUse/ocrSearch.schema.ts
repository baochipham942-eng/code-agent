// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const ocrSearchSchema: ToolSchema = {
  name: 'ocr_search',
  description: `图片 OCR 工具 — 用 macOS Vision Framework (VNRecognizeTextRequest) 识别图片内文字，
零额外配置（系统自带，离线，免费），支持中英文。识别结果带边界框坐标。

**适用场景**：
- OCR 一张图片（截图、扫描件、文档）
- 提取图片内文字后入库 (memories 表 type='ocr_result')，便于后续按文字搜索历史截图
- 在用户问"找含 XX 文字的截图"时，先 OCR 历史图片再用 memory_search 检索

**与 image_analyze 的区别**：
- ocr_search：纯文字提取 + 坐标，零外部 API
- image_analyze：复合视觉理解（看图说话/表格语义），走多模态 LLM

**与 image_annotate 的区别**：
- ocr_search：识别 + 入库，不修改图片
- image_annotate：在图片上画标注框，输出新图

**前置条件**：
- 仅 macOS（依赖 Vision Framework）
- macOS 11+（中文需要 macOS 13+）
- vision-ocr binary 已编译并位于 scripts/ 或 Tauri Resources/

参数：
- imagePath: 图片绝对路径（必填）
- languages: 识别语言数组（可选，默认 ["zh-Hans", "zh-Hant", "en-US"]）
- persist: 是否入库 memories 表（可选，默认 true）

返回：
- fullText: 完整识别文字（按行拼接）
- regions: 文本块数组，每个含 text/confidence/boundingBox(x/y/width/height 像素坐标)
- imageSize: { width, height }
- memoryId: 若 persist=true，返回入库的 memory id`,
  inputSchema: {
    type: 'object',
    properties: {
      imagePath: {
        type: 'string',
        description: '图片绝对路径，支持 jpg/jpeg/png/webp/gif/bmp/tiff/heic',
      },
      languages: {
        type: 'array',
        items: { type: 'string' },
        description: '识别语言代码数组，默认 ["zh-Hans", "zh-Hant", "en-US"]',
      },
      persist: {
        type: 'boolean',
        description: '是否入库 memories 表，默认 true。设 false 仅返回不持久化',
      },
    },
    required: ['imagePath'],
  },
  category: 'vision',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
