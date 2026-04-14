// ============================================================================
// WebFetch (P0-5 POC version)
//
// 最小实现：纯 HTTP GET + 文本截断，不走 AI 提取（不依赖 ctx.modelCallback）
// 旧版 src/main/tools/web/webFetch.ts 有信任域硬编码、HTML 清洗、AI 提取等
// 复杂路径，POC 只验证：
//   1. network 类 tool 的 canUseTool 闸门
//   2. 无 API key 也能工作（node fetch 原生）
//   3. abortSignal 取消 HTTP 请求
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
  ToolSchema,
} from '../../protocol/tools';

const schema: ToolSchema = {
  name: 'WebFetchPoc',
  description: '抓取 URL 内容并返回纯文本（P0-5 POC 版本，无 AI 提取）',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整 URL' },
      max_chars: { type: 'number', description: '返回内容字符上限，默认 8000' },
    },
    required: ['url'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};

interface WebFetchOutput {
  url: string;
  status: number;
  contentType: string;
  content: string;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 8000;
const REQUEST_TIMEOUT_MS = 30_000;

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class WebFetchPocHandler implements ToolHandler<Record<string, unknown>, WebFetchOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<WebFetchOutput>> {
    const url = args.url as string | undefined;
    const maxChars = (args.max_chars as number | undefined) ?? DEFAULT_MAX_CHARS;

    if (!url || typeof url !== 'string') {
      return { ok: false, error: 'url 必须是字符串', code: 'INVALID_ARGS' };
    }

    // URL 合法性检查
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, error: `invalid URL: ${url}`, code: 'INVALID_URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: `unsupported protocol: ${parsed.protocol}`, code: 'INVALID_URL' };
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'starting', detail: `fetch ${parsed.host}` });

    // 内部 AbortController 管 timeout，外部 ctx.abortSignal 也 abort 掉
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    ctx.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

    try {
      onProgress?.({ stage: 'running', percent: 30 });
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'code-agent-webfetch-poc/0.1',
          'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        },
      });

      const contentType = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      onProgress?.({ stage: 'running', percent: 80 });

      let content: string;
      if (contentType.includes('application/json') || contentType.includes('text/plain')) {
        content = raw;
      } else {
        content = stripHtmlTags(raw);
      }

      const truncated = content.length > maxChars;
      if (truncated) content = content.slice(0, maxChars);

      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.info('WebFetchPoc done', {
        url,
        status: res.status,
        contentLen: content.length,
        truncated,
      });

      return {
        ok: true,
        output: {
          url,
          status: res.status,
          contentType,
          content,
          truncated,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes('aborted') ? 'ABORTED' : 'FETCH_ERROR';
      ctx.logger.warn('WebFetchPoc failed', { url, err: msg });
      return { ok: false, error: msg, code };
    } finally {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export const webFetchPocModule: ToolModule<Record<string, unknown>, WebFetchOutput> = {
  schema,
  createHandler() {
    return new WebFetchPocHandler();
  },
};
