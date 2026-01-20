// ============================================================================
// Read Clipboard Tool - 读取系统剪贴板内容
// ============================================================================

import { clipboard, nativeImage } from 'electron';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';

export const readClipboardTool: Tool = {
  name: 'read_clipboard',
  description: `Read the contents of the system clipboard.

Supports:
- Text content (plain text, code, URLs, etc.)
- Image content (returns base64 encoded PNG)

Use cases:
- User says "check my clipboard" or "what's in my clipboard"
- User wants to paste code/text without manually doing so
- Analyzing clipboard images

Returns: Text content or base64-encoded image data with metadata`,
  generations: ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['text', 'image', 'auto'],
        description: 'Format to read: "text" for text only, "image" for image only, "auto" to detect (default: auto)',
      },
    },
    required: [],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const format = (params.format as string) || 'auto';

    try {
      // 检查剪贴板格式
      const availableFormats = clipboard.availableFormats();

      // Auto detect or specific format
      const hasText = availableFormats.some(f =>
        f.includes('text') || f.includes('string') || f.includes('html')
      );
      const hasImage = availableFormats.some(f =>
        f.includes('image') || f.includes('png') || f.includes('jpeg')
      );

      // 根据 format 参数决定读取什么
      if (format === 'text' || (format === 'auto' && hasText)) {
        const text = clipboard.readText();

        if (!text || text.trim().length === 0) {
          // 尝试读取 HTML
          const html = clipboard.readHTML();
          if (html && html.trim().length > 0) {
            return {
              success: true,
              output: `[Clipboard HTML Content]\n${html}`,
            };
          }

          // 如果 auto 模式且没有文本但有图片，尝试读取图片
          if (format === 'auto' && hasImage) {
            return readImageFromClipboard();
          }

          return {
            success: true,
            output: '[Clipboard is empty or contains no text]',
          };
        }

        // 限制文本长度避免过大
        const maxLength = 50000;
        const truncated = text.length > maxLength;
        const output = truncated
          ? text.substring(0, maxLength) + `\n\n... (truncated, total ${text.length} characters)`
          : text;

        return {
          success: true,
          output: `[Clipboard Text Content (${text.length} chars)]\n${output}`,
        };
      }

      if (format === 'image' || (format === 'auto' && hasImage && !hasText)) {
        return readImageFromClipboard();
      }

      return {
        success: true,
        output: `[Clipboard is empty]\nAvailable formats: ${availableFormats.join(', ') || 'none'}`,
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Failed to read clipboard: ${error.message || 'Unknown error'}`,
      };
    }
  },
};

/**
 * 从剪贴板读取图片
 */
function readImageFromClipboard(): ToolExecutionResult {
  const image = clipboard.readImage();

  if (image.isEmpty()) {
    return {
      success: true,
      output: '[Clipboard contains no image]',
    };
  }

  const size = image.getSize();
  const pngBuffer = image.toPNG();
  const base64 = pngBuffer.toString('base64');

  // 限制图片大小（10MB base64 约等于 7.5MB 原始）
  if (base64.length > 10 * 1024 * 1024) {
    return {
      success: false,
      error: `Image too large: ${Math.round(base64.length / 1024 / 1024)}MB. Maximum 10MB supported.`,
    };
  }

  return {
    success: true,
    output: `[Clipboard Image]\nSize: ${size.width}x${size.height} pixels\nFormat: PNG\nData (base64): ${base64}`,
  };
}
