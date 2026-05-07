// ============================================================================
// WebFetch Unified (Level 2 native module)
//
// Directly implements fetch and request paths. Fetch uses shared fetchDocument
// plus HTML/markdown extraction helpers; request delegates to native http_request.
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { WEB_FETCH } from '../../../../shared/constants';
import {
  smartHtmlToText,
  smartTruncate,
  buildExtractionPrompt,
} from '../../web/htmlUtils';
import { fetchDocument } from '../../web/fetchDocument';
import { executeHttpRequest } from './httpRequest';
import { webFetchUnifiedSchema as schema } from './webFetchUnified.schema';
import { detectAntiScrapingHint } from './antiScrapingDetector';
import { createVirtualArtifact } from '../../artifacts/artifactMeta';

function safeUrlName(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  try {
    return new URL(url).hostname;
  } catch {
    return fallback;
  }
}

const DEFAULT_MAX_CHARS = 8000;

function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Protocol not allowed: ${parsed.protocol}. Only http:// and https:// are allowed.`;
    }
    return null;
  } catch {
    return `Invalid URL: ${url}`;
  }
}

async function extractOrTruncate(
  content: string,
  prompt: string,
  maxChars: number,
  ctx: ToolContext,
): Promise<{ content: string; usedModel: boolean }> {
  if (ctx.modelCallback && content.length > 0) {
    try {
      const extractionPrompt = buildExtractionPrompt(prompt, content, maxChars);
      const extracted = await ctx.modelCallback(extractionPrompt);
      if (extracted && extracted.trim().length > 50) {
        return { content: extracted.trim(), usedModel: true };
      }
    } catch {
      // Graceful fallback to deterministic truncation.
    }
  }
  return { content: smartTruncate(content, maxChars), usedModel: false };
}

async function executeFetchAction(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  const url = args.url as string;
  const prompt = args.prompt as string;
  const maxChars = (args.max_chars as number | undefined) || DEFAULT_MAX_CHARS;
  const urlError = validateUrl(url);
  if (urlError) {
    return { ok: false, error: urlError, code: 'INVALID_ARGS' };
  }

  try {
    const doc = await fetchDocument(url);
    const effectiveUrl = doc.finalUrl;
    const contentType = doc.contentType;
    let content = '';
    let extractionMode: 'json' | 'markdown' | 'html' = 'html';
    let usedModel = false;

    if (contentType.includes('application/json')) {
      extractionMode = 'json';
      try {
        content = JSON.stringify(JSON.parse(doc.content), null, 2);
      } catch {
        content = doc.content;
      }
      if (content.length > maxChars) {
        content = smartTruncate(content, maxChars);
      }
    } else if (contentType.includes('text/markdown')) {
      extractionMode = 'markdown';
      const shouldSkipModel =
        !doc.crossDomainRedirect &&
        doc.content.length < WEB_FETCH.TRUSTED_DOCS_MAX_CHARS &&
        doc.content.length <= maxChars;
      if (shouldSkipModel) {
        content = doc.content;
      } else {
        const extracted = await extractOrTruncate(doc.content, prompt, maxChars, ctx);
        content = extracted.content;
        usedModel = extracted.usedModel;
      }
    } else {
      extractionMode = 'html';
      const text = smartHtmlToText(doc.content, effectiveUrl);
      const extracted = await extractOrTruncate(text, prompt, maxChars, ctx);
      content = extracted.content;
      usedModel = extracted.usedModel;
    }

    const cacheNote = doc.fromCache ? ' (cached)' : '';
    const output = `Fetched content from: ${effectiveUrl}${cacheNote}\n` +
      `Prompt: ${prompt}\n\n` +
      `Content:\n${content}`;

    return {
      ok: true,
      output,
      meta: {
        finalUrl: effectiveUrl,
        requestedUrl: url,
        statusCode: doc.statusCode,
        contentType,
        fromCache: doc.fromCache,
        crossDomainRedirect: doc.crossDomainRedirect,
        extractionMode,
        usedModel,
        maxChars,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Failed to fetch URL: ${message}`, code: 'NETWORK_ERROR' };
  }
}

class WebFetchUnifiedHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    const validationError = validateWebFetchUnifiedArgs(args);
    if (validationError) return validationError;

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    const action = typeof args.action === 'string' ? args.action : 'fetch';
    onProgress?.({ stage: 'starting', detail: action ? `WebFetch ${action}` : 'WebFetch' });

    const result = action === 'request'
      ? await executeHttpRequest(args, ctx, canUseTool, onProgress)
      : await executeFetchAction(args, ctx);
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('WebFetch done', { action, ok: result.ok });

    // 反爬命中处理：原 output 是 LLM 处理后的长 markdown（反爬场景下没价值——模型
    // 自己也只能说"没找到内容"），下游 compressToolResult 会把超阈值的整段砍成
    // "... [N lines truncated] ..." placeholder，hint 不管放头放尾都被吞。
    //
    // 解法：反爬命中时直接替换 output 为短文本（hint + URL + 原内容前 500 字
    // 用来保留状态码线索），总长 ~1500 chars 远低于压缩阈值，模型 100% 能看到。
    const url = typeof args.url === 'string' ? args.url : undefined;
    const hint = detectAntiScrapingHint(url, result.ok, result.ok ? result.output : undefined, result.ok ? undefined : result.error);
    if (hint) {
      if (result.ok) {
        const preview = result.output.slice(0, 500);
        result.output = `${hint}\n\n--- Original response preview (truncated, anti-scraping detected) ---\n${preview}`;
      } else {
        const preview = result.error.slice(0, 500);
        result.error = `${hint}\n\n--- Original error preview ---\n${preview}`;
      }
      ctx.logger.debug('WebFetch anti-scraping hint emitted (output replaced with short form)', { url });
    }

    if (result.ok) {
      return {
        ...result,
        meta: {
          ...(result.meta ?? {}),
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'web',
            sessionId: ctx.sessionId,
            name: safeUrlName(url, 'WebFetch result'),
            url: typeof result.meta?.finalUrl === 'string' ? result.meta.finalUrl : url,
            mimeType: action === 'request' ? 'application/http' : 'text/markdown',
            contentLength: result.output.length,
            preview: result.output.slice(0, 500),
            metadata: {
              action,
              requestedUrl: url,
              ...result.meta,
            },
          }),
        },
      };
    }
    return result;
  }
}

function validateWebFetchUnifiedArgs(args: Record<string, unknown>): ToolResult<string> | null {
  const action = typeof args.action === 'string' ? args.action : 'fetch';
  if (action !== 'fetch' && action !== 'request') {
    return { ok: false, error: 'Invalid WebFetch action. Use "fetch" or "request".', code: 'INVALID_ARGS' };
  }

  if (typeof args.url !== 'string' || args.url.trim().length === 0) {
    return { ok: false, error: 'WebFetch requires a non-empty url.', code: 'INVALID_ARGS' };
  }

  if (action === 'fetch' && (typeof args.prompt !== 'string' || args.prompt.trim().length === 0)) {
    return { ok: false, error: 'WebFetch action "fetch" requires a non-empty prompt.', code: 'INVALID_ARGS' };
  }

  return null;
}

export const webFetchUnifiedModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WebFetchUnifiedHandler();
  },
};
