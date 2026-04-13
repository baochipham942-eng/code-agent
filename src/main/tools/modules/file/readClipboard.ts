// ============================================================================
// ReadClipboard (P0-5 Migrated to ToolModule)
//
// 旧版: src/main/tools/file/readClipboard.ts (registered as 'read_clipboard')
// 改造点：
// - 4 参数签名
// - canUseTool 真权限闸门
// - 仍依赖 platform.clipboard（无 abstract 替代品，平台层是允许的依赖）
// - 输出格式与 legacy 字节级一致
// ============================================================================

import { clipboard } from '../../../platform';
import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { readClipboardSchema as schema } from './readClipboard.schema';

const MAX_TEXT_LEN = 50000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function readImageFromClipboard(): ToolResult<string> {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return { ok: true, output: '[Clipboard contains no image]' };
  }
  const size = image.getSize();
  const pngBuffer = image.toPNG();
  const base64 = pngBuffer.toString('base64');
  if (base64.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Image too large: ${Math.round(base64.length / 1024 / 1024)}MB. Maximum 10MB supported.`,
      code: 'IMAGE_TOO_LARGE',
    };
  }
  return {
    ok: true,
    output: `[Clipboard Image]\nSize: ${size.width}x${size.height} pixels\nFormat: PNG\nData (base64): ${base64}`,
  };
}

class ReadClipboardHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const format = (args.format as string | undefined) ?? 'auto';

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `read clipboard ${format}` });

    try {
      const availableFormats = clipboard.availableFormats();
      const hasText = availableFormats.some((f) =>
        f.includes('text') || f.includes('string') || f.includes('html'),
      );
      const hasImage = availableFormats.some((f) =>
        f.includes('image') || f.includes('png') || f.includes('jpeg'),
      );

      if (format === 'text' || (format === 'auto' && hasText)) {
        const text = clipboard.readText();
        if (!text || text.trim().length === 0) {
          const html = clipboard.readHTML();
          if (html && html.trim().length > 0) {
            return { ok: true, output: `[Clipboard HTML Content]\n${html}` };
          }
          if (format === 'auto' && hasImage) {
            return readImageFromClipboard();
          }
          return { ok: true, output: '[Clipboard is empty or contains no text]' };
        }
        const truncated = text.length > MAX_TEXT_LEN;
        const out = truncated
          ? text.substring(0, MAX_TEXT_LEN) + `\n\n... (truncated, total ${text.length} characters)`
          : text;
        return {
          ok: true,
          output: `[Clipboard Text Content (${text.length} chars)]\n${out}`,
        };
      }

      if (format === 'image' || (format === 'auto' && hasImage && !hasText)) {
        return readImageFromClipboard();
      }

      return {
        ok: true,
        output: `[Clipboard is empty]\nAvailable formats: ${availableFormats.join(', ') || 'none'}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn('ReadClipboard failed', { err: message });
      return { ok: false, error: `Failed to read clipboard: ${message || 'Unknown error'}`, code: 'CLIPBOARD_ERROR' };
    }
  }
}

export const readClipboardModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ReadClipboardHandler();
  },
};
