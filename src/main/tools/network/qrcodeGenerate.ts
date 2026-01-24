// ============================================================================
// QR Code Generate Tool - 生成二维码
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('QRCodeGenerate');

interface QRCodeGenerateParams {
  content: string;
  output_path?: string;
  size?: number;
  color?: string;
  background?: string;
  margin?: number;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const qrcodeGenerateTool: Tool = {
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
\`\`\`

电话号码：
\`\`\`
qrcode_generate { "content": "tel:+8613800138000" }
\`\`\``,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',
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
        default: 300,
      },
      color: {
        type: 'string',
        description: '二维码颜色（默认: #000000）',
        default: '#000000',
      },
      background: {
        type: 'string',
        description: '背景颜色（默认: #ffffff）',
        default: '#ffffff',
      },
      margin: {
        type: 'number',
        description: '边距（默认: 4）',
        default: 4,
      },
    },
    required: ['content'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const {
      content,
      output_path,
      size = 300,
      color = '#000000',
      background = '#ffffff',
      margin = 4,
    } = params as unknown as QRCodeGenerateParams;

    try {
      // 确定输出路径
      const timestamp = Date.now();
      const fileName = `qrcode-${timestamp}.png`;
      const outputDir = output_path
        ? path.dirname(output_path)
        : context.workingDirectory;
      const finalPath = output_path || path.join(outputDir, fileName);

      // 确保目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      context.emit?.('tool_output', {
        tool: 'qrcode_generate',
        message: '🔲 正在生成二维码...',
      });

      // 生成二维码
      await QRCode.toFile(finalPath, content, {
        width: size,
        margin,
        color: {
          dark: color,
          light: background,
        },
      });

      const stats = fs.statSync(finalPath);

      // 判断内容类型
      let contentType = '文本';
      if (content.startsWith('http://') || content.startsWith('https://')) {
        contentType = 'URL';
      } else if (content.startsWith('WIFI:')) {
        contentType = 'WiFi';
      } else if (content.startsWith('tel:')) {
        contentType = '电话';
      } else if (content.startsWith('mailto:')) {
        contentType = '邮件';
      } else if (content.startsWith('BEGIN:VCARD')) {
        contentType = '名片';
      }

      logger.info('QR code generated', { contentType, path: finalPath });

      return {
        success: true,
        output: `✅ 二维码已生成！

🔲 类型: ${contentType}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}
📏 尺寸: ${size}x${size}

点击上方路径可直接打开。`,
        metadata: {
          filePath: finalPath,
          fileName: path.basename(finalPath),
          fileSize: stats.size,
          contentType,
          attachment: {
            id: `qrcode-${timestamp}`,
            type: 'file',
            category: 'image',
            name: path.basename(finalPath),
            path: finalPath,
            size: stats.size,
            mimeType: 'image/png',
          },
        },
      };
    } catch (error: any) {
      logger.error('QR code generation failed', { error: error.message });
      return {
        success: false,
        error: `二维码生成失败: ${error.message}`,
      };
    }
  },
};
