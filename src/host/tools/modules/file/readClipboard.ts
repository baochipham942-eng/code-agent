// ============================================================================
// ReadClipboard (P0-5 Migrated to ToolModule)
//
// 旧版: src/host/tools/file/readClipboard.ts (registered as 'read_clipboard')
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
import { createVirtualArtifact } from '../../artifacts/artifactMeta';

const MAX_TEXT_LEN = 50000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function buildClipboardMeta(
  ctx: ToolContext,
  output: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    artifact: createVirtualArtifact({
      sourceTool: schema.name,
      kind: metadata.kind === 'image' ? 'image' : 'text',
      sessionId: ctx.sessionId,
      name: `clipboard-${String(metadata.format ?? metadata.kind ?? 'content')}`,
      mimeType: metadata.kind === 'image' ? 'image/png' : 'text/plain',
      contentLength: output.length,
      preview: output.slice(0, 500),
      metadata: {
        source: 'clipboard',
        ...metadata,
      },
    }),
  };
}

function readImageFromClipboard(ctx: ToolContext): ToolResult<string> {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    const output = '[Clipboard contains no image]';
    return {
      ok: true,
      output,
      meta: buildClipboardMeta(ctx, output, {
        kind: 'image',
        format: 'image',
        empty: true,
      }),
    };
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
  const output = `[Clipboard Image]\nSize: ${size.width}x${size.height} pixels\nFormat: PNG\nData (base64): ${base64}`;
  return {
    ok: true,
    output,
    meta: buildClipboardMeta(ctx, output, {
      kind: 'image',
      format: 'image',
      width: size.width,
      height: size.height,
      bytes: pngBuffer.byteLength,
      base64Length: base64.length,
    }),
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
            const output = `[Clipboard HTML Content]\n${html}`;
            return {
              ok: true,
              output,
              meta: buildClipboardMeta(ctx, output, {
                kind: 'text',
                format: 'html',
                contentLength: html.length,
                truncated: false,
                availableFormats,
              }),
            };
          }
          if (format === 'auto' && hasImage) {
            return readImageFromClipboard(ctx);
          }
          const output = '[Clipboard is empty or contains no text]';
          return {
            ok: true,
            output,
            meta: buildClipboardMeta(ctx, output, {
              kind: 'text',
              format,
              empty: true,
              availableFormats,
            }),
          };
        }
        const truncated = text.length > MAX_TEXT_LEN;
        const out = truncated
          ? text.substring(0, MAX_TEXT_LEN) + `\n\n... (truncated, total ${text.length} characters)`
          : text;
        const output = `[Clipboard Text Content (${text.length} chars)]\n${out}`;
        return {
          ok: true,
          output,
          meta: buildClipboardMeta(ctx, output, {
            kind: 'text',
            format: 'text',
            contentLength: text.length,
            returnedLength: out.length,
            truncated,
            availableFormats,
          }),
        };
      }

      if (format === 'image' || (format === 'auto' && hasImage && !hasText)) {
        return readImageFromClipboard(ctx);
      }

      const output = `[Clipboard is empty]\nAvailable formats: ${availableFormats.join(', ') || 'none'}`;
      return {
        ok: true,
        output,
        meta: buildClipboardMeta(ctx, output, {
          kind: 'text',
          format,
          empty: true,
          availableFormats,
        }),
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
