// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const qrcodeGenerateSchema: ToolSchema = {
  name: 'qrcode_generate',
  description: `生成二维码图片（PNG 格式）。

支持生成各种内容的二维码：
- 网址 URL
- 文本内容
- 名片信息（vCard）
- WiFi 连接信息
- 电话号码
- 邮件地址

**使用示例：**

网址二维码：
\`\`\`
qrcode_generate { "content": "https://example.com" }
\`\`\`

带样式的二维码：
\`\`\`
qrcode_generate {
  "content": "https://example.com",
  "size": 400,
  "color": "#1a365d",
  "background": "#ffffff"
}
\`\`\`

WiFi 连接二维码：
\`\`\`
qrcode_generate { "content": "WIFI:T:WPA;S:MyNetwork;P:MyPassword;;" }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: '二维码内容（URL、文本、vCard 等）',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（默认: 工作目录下的 qrcode-{timestamp}.png）',
      },
      size: {
        type: 'number',
        description: '二维码尺寸（默认: 300）',
      },
      color: {
        type: 'string',
        description: '二维码颜色（默认: #000000）',
      },
      background: {
        type: 'string',
        description: '背景颜色（默认: #ffffff）',
      },
      margin: {
        type: 'number',
        description: '边距（默认: 4）',
      },
    },
    required: ['content'],
  },
  category: 'network',
  permissionLevel: 'write',
  readOnly: false,
  allowInPlanMode: false,
};
