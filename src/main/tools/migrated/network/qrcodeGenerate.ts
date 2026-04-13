// ============================================================================
// qrcode_generate (P0-6.3 Batch 7 — network: native ToolModule rewrite)
//
// 使用 `qrcode` 包生成 PNG 二维码
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { formatFileSize } from '../../network/utils';

interface QRCodeGenerateParams {
  content: string;
  output_path?: string;
  size?: number;
  color?: string;
  background?: string;
  margin?: number;
}

const schema: ToolSchema = {
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

async function executeQrcodeGenerate(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const p = args as unknown as QRCodeGenerateParams;
  const content = p.content;
  const output_path = p.output_path;
  const size = p.size ?? 300;
  const color = p.color ?? '#000000';
  const background = p.background ?? '#ffffff';
  const margin = p.margin ?? 4;

  if (typeof content !== 'string' || content.length === 0) {
    return { ok: false, error: 'content is required', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: 'qrcode_generate' });

  try {
    const timestamp = Date.now();
    const fileName = `qrcode-${timestamp}.png`;
    const outputDir = output_path ? path.dirname(output_path) : ctx.workingDir;
    const finalPath = output_path || path.join(outputDir, fileName);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    onProgress?.({ stage: 'running', detail: '正在生成二维码...' });

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

    ctx.logger.info('QR code generated', { contentType, path: finalPath });
    onProgress?.({ stage: 'completing', percent: 100 });

    return {
      ok: true,
      output: `✅ 二维码已生成！

🔲 类型: ${contentType}
📄 文件: ${finalPath}
📦 大小: ${formatFileSize(stats.size)}
📏 尺寸: ${size}x${size}

点击上方路径可直接打开。`,
      meta: {
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error('QR code generation failed', { error: message });
    return { ok: false, error: `二维码生成失败: ${message}` };
  }
}

class QrcodeGenerateHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeQrcodeGenerate(args, ctx, canUseTool, onProgress);
  }
}

export const qrcodeGenerateModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new QrcodeGenerateHandler();
  },
};
