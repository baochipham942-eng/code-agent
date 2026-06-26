// Schema-only file (P0-7 方案 A — single source of truth)
// screenshot_page — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

export const screenshotPageSchema: ToolSchema = {
  name: 'screenshot_page',
  description: `截取网页屏幕截图，支持 AI 内容分析。

使用在线 API 服务截取网页，支持自定义视口大小和全页截图。
可选启用 AI 分析，理解网页内容、布局、文字等。

**使用示例：**
\`\`\`
screenshot_page { "url": "https://example.com" }
screenshot_page { "url": "https://github.com", "width": 1920, "height": 1080 }
screenshot_page { "url": "https://news.ycombinator.com", "full_page": true }
screenshot_page { "url": "https://example.com", "analyze": true }
screenshot_page { "url": "https://example.com", "analyze": true, "prompt": "这个网页是做什么的？" }
\`\`\`

**参数说明：**
- width: 视口宽度（默认: 1280）
- height: 视口高度（默认: 800）
- full_page: 截取完整页面（默认: false）
- format: 输出格式 png/jpg（默认: png）
- delay: 等待页面加载的毫秒数（默认: 0）
- analyze: 启用 AI 分析（默认: false）
- prompt: 自定义分析提示词`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要截图的网页 URL',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下自动生成）',
      },
      width: {
        type: 'number',
        description: '视口宽度（默认: 1280）',
        default: 1280,
      },
      height: {
        type: 'number',
        description: '视口高度（默认: 800）',
        default: 800,
      },
      full_page: {
        type: 'boolean',
        description: '是否截取完整页面（默认: false）',
        default: false,
      },
      format: {
        type: 'string',
        enum: ['png', 'jpg'],
        description: '输出格式（默认: png）',
        default: 'png',
      },
      delay: {
        type: 'number',
        description: '等待页面加载的毫秒数（默认: 0）',
        default: 0,
      },
      analyze: {
        type: 'boolean',
        description: '启用 AI 分析网页内容（默认: false）',
        default: false,
      },
      prompt: {
        type: 'string',
        description: '自定义分析提示词（默认: 分析网页内容和布局）',
      },
    },
    required: ['url'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
