// ============================================================================
// WebSearch (P0-5 POC version)
//
// 验证点：
// 1. requiresApiKey schema 字段 — 声明依赖的 key 名
// 2. createHandler 是 async — 可做 API client 惰性初始化（首次 resolve 时才跑）
// 3. 零 services 导入 — api key 通过环境变量读取，不走 configService
//
// POC 实现不打真网络请求，只 mock：从 process.env 拿 key、返回固定结果。
// 生产版迁移时保留这个 schema/handler 形态，把 handler 内部的 mock 换成真实
// parallelSearch/serialSearch 调用即可。
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
  name: 'WebSearchPoc',
  description: '联网搜索（P0-5 POC 版本，验证 requiresApiKey + lazy client 初始化）',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
    },
    required: ['query'],
  },
  category: 'network',
  permissionLevel: 'network',
  requiresApiKey: ['PERPLEXITY_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY'],
  readOnly: true,
  allowInPlanMode: true,
};

interface SearchOutput {
  results: Array<{ title: string; url: string; snippet: string }>;
  provider: string;
}

/**
 * 模拟一个需要昂贵初始化的 client（生产版里这里会是真实的 HTTP client
 * + API key 校验 + 连接池）。createHandler async 形态保证这段只跑一次。
 */
async function initSearchClient(ctx: {
  logger: { info: (msg: string, meta?: unknown) => void };
}): Promise<{ provider: string; hasKey: boolean }> {
  const keys = {
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  };
  const firstAvailable = Object.entries(keys).find(([_, v]) => !!v);
  const provider = firstAvailable ? firstAvailable[0].replace('_API_KEY', '') : 'none';
  // 模拟 100ms 的 init 开销
  await new Promise((r) => setTimeout(r, 10));
  ctx.logger.info('WebSearchPoc client initialized', { provider });
  return { provider, hasKey: !!firstAvailable };
}

class WebSearchPocHandler implements ToolHandler<Record<string, unknown>, SearchOutput> {
  readonly schema = schema;
  constructor(private readonly client: { provider: string; hasKey: boolean }) {}

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<SearchOutput>> {
    const query = args.query as string | undefined;
    if (!query || typeof query !== 'string') {
      return { ok: false, error: 'query 必须是字符串', code: 'INVALID_ARGS' };
    }

    const permit = await canUseTool(schema.name, { query });
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }

    if (!this.client.hasKey) {
      ctx.logger.warn('WebSearchPoc no api key available', { required: schema.requiresApiKey });
      return {
        ok: false,
        error: `WebSearch 需要以下 API key 之一: ${schema.requiresApiKey?.join(', ')}`,
        code: 'API_KEY_MISSING',
      };
    }

    onProgress?.({ stage: 'starting', detail: `searching: ${query.slice(0, 40)}` });

    // POC mock：实际生产版这里走 parallelSearch
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    onProgress?.({ stage: 'running', percent: 50 });
    const results = [
      {
        title: `[mock] Result for "${query}"`,
        url: `https://example.com/search?q=${encodeURIComponent(query)}`,
        snippet: `Mock snippet from ${this.client.provider}`,
      },
    ];

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('WebSearchPoc done', { query, provider: this.client.provider, count: results.length });

    return {
      ok: true,
      output: { results, provider: this.client.provider },
    };
  }
}

export const webSearchPocModule: ToolModule<Record<string, unknown>, SearchOutput> = {
  schema,
  async createHandler() {
    // 这段 async 初始化只在 registry.resolve('WebSearchPoc') 首次调用时执行
    // 生产版：init API client + 连接池 + 校验 key 合法性
    const client = await initSearchClient({
      logger: {
        info: (msg, meta) => console.log(`[webSearchPoc:init] ${msg}`, meta ?? ''),
      },
    });
    return new WebSearchPocHandler(client);
  },
};
