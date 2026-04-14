// ============================================================================
// Tool Registry (P0-5 POC)
//
// 三段式查询链（参考 Claude Code CLI 2.1.88 leaked tools.ts 的 getAllBaseTools
// / getTools / assembleToolPool / filterToolsByDenyRules）：
//   register(schema, loader)  —— 启动时填充 schemas Map + loaders Map
//   getSchemas() / getSchemasForMode() —— 不加载 handler，只返回 schema
//   resolve(name) —— 首次调用时执行 loader，缓存 handler 实例
//
// 与旧 ToolRegistry (src/main/tools/registry/toolRegistry.ts 之类) 并存。旧系统
// 不动，新路径用 feature flag 控制，POC 验证后再批量迁移。
// ============================================================================

import type {
  ToolRegistry as IToolRegistry,
  ToolSchema,
  ToolHandler,
  ToolLoader,
  ToolFilterOptions,
} from '../protocol/tools';

export class ToolRegistry implements IToolRegistry {
  private readonly schemas = new Map<string, ToolSchema>();
  private readonly loaders = new Map<string, ToolLoader>();
  private readonly handlers = new Map<string, ToolHandler>();
  /** 正在进行的加载（并发调用合并成同一个 Promise）*/
  private readonly inflight = new Map<string, Promise<ToolHandler>>();

  register(schema: ToolSchema, loader: ToolLoader): void {
    if (this.schemas.has(schema.name)) {
      // 幂等：同名重复注册覆盖（热重载/测试）
      this.schemas.set(schema.name, schema);
      this.loaders.set(schema.name, loader);
      this.handlers.delete(schema.name);
      this.inflight.delete(schema.name);
      return;
    }
    this.schemas.set(schema.name, schema);
    this.loaders.set(schema.name, loader);
  }

  getSchemas(): readonly ToolSchema[] {
    return Array.from(this.schemas.values());
  }

  getSchemasForMode(opts: ToolFilterOptions): readonly ToolSchema[] {
    const { readOnly, categories, deny } = opts;
    const catSet = categories ? new Set(categories) : null;
    const result: ToolSchema[] = [];
    for (const schema of this.schemas.values()) {
      if (deny?.has(schema.name)) continue;
      if (readOnly === true && !schema.readOnly) continue;
      if (catSet && !catSet.has(schema.category)) continue;
      result.push(schema);
    }
    // 字典序稳定排序，保证 LLM prompt cache 命中
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  async resolve(name: string): Promise<ToolHandler> {
    const cached = this.handlers.get(name);
    if (cached) return cached;

    const pending = this.inflight.get(name);
    if (pending) return pending;

    const loader = this.loaders.get(name);
    if (!loader) {
      throw new Error(`Tool "${name}" is not registered`);
    }

    const promise = (async () => {
      const mod = await loader();
      if (mod.schema.name !== name) {
        throw new Error(
          `Tool module name mismatch: registered as "${name}" but module.schema.name is "${mod.schema.name}"`,
        );
      }
      const handler = await mod.createHandler();
      this.handlers.set(name, handler);
      this.inflight.delete(name);
      return handler;
    })();

    this.inflight.set(name, promise);
    return promise;
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }

  unregister(name: string): boolean {
    if (!this.schemas.has(name)) return false;
    this.schemas.delete(name);
    this.loaders.delete(name);
    this.handlers.delete(name);
    this.inflight.delete(name);
    return true;
  }

  reset(): void {
    this.schemas.clear();
    this.loaders.clear();
    this.handlers.clear();
    this.inflight.clear();
  }
}

// ----------------------------------------------------------------------------
// POC 默认 registry + 3 个 POC tool 的注册函数
// 注意：registerPocTools 只注册 schema，handler 会在 resolve(name) 首次调用时
// 通过 dynamic import 拉 tool 模块。启动时**不**触发这些 import。
// ----------------------------------------------------------------------------

export function registerPocTools(registry: ToolRegistry): void {
  // Read — 最简单，仅依赖 fs + workingDir
  registry.register(
    {
      name: 'ReadPoc',
      description: '读取文件内容（P0-5 POC 版本，走 ToolModule 接口）',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '绝对路径' },
          offset: { type: 'number', description: '起始行号 (1-indexed)' },
          limit: { type: 'number', description: '读取行数上限' },
        },
        required: ['file_path'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./file/readPoc')).readPocModule,
  );

  // Bash — 最复杂，依赖 permission + abortSignal + onProgress
  registry.register(
    {
      name: 'BashPoc',
      description: '执行 shell 命令（P0-5 POC 版本，走 ToolModule + canUseTool）',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          timeout: { type: 'number', description: '超时 ms' },
        },
        required: ['command'],
      },
      category: 'shell',
      permissionLevel: 'execute',
      readOnly: false,
      allowInPlanMode: false,
    },
    async () => (await import('./shell/bashPoc')).bashPocModule,
  );

  // WebSearch — 有 API key 依赖，验证 requiresApiKey 和 lazy init
  registry.register(
    {
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
    },
    async () => (await import('./web/webSearchPoc')).webSearchPocModule,
  );

  // Glob — readOnly fs 查找，最小实现直接用 glob 库
  registry.register(
    {
      name: 'GlobPoc',
      description: '按 glob pattern 查找文件（P0-5 POC 版本）',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./file/globPoc')).globPocModule,
  );

  // Grep — ripgrep spawn，验证 child_process + stdout chunking 对新签名的适配
  registry.register(
    {
      name: 'GrepPoc',
      description: '按正则在文件中搜索（P0-5 POC 版本，只走 ripgrep）',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          type: { type: 'string' },
          case_insensitive: { type: 'boolean' },
          head_limit: { type: 'number' },
        },
        required: ['pattern'],
      },
      category: 'fs',
      permissionLevel: 'read',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./shell/grepPoc')).grepPocModule,
  );

  // WebFetch — 纯 HTTP GET，验证 abortSignal 取消 fetch
  registry.register(
    {
      name: 'WebFetchPoc',
      description: '抓取 URL 内容并返回纯文本（P0-5 POC 版本）',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          max_chars: { type: 'number' },
        },
        required: ['url'],
      },
      category: 'network',
      permissionLevel: 'network',
      readOnly: true,
      allowInPlanMode: true,
    },
    async () => (await import('./web/webFetchPoc')).webFetchPocModule,
  );

  // Write — DRY RUN ONLY，验证副作用类工具如何走 4 参数签名而不实际改文件
  registry.register(
    {
      name: 'WritePoc',
      description: '写入文件（P0-5 POC dry-run 版本，不实际写盘）',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['file_path', 'content'],
      },
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: true,
    },
    async () => (await import('./file/writePoc')).writePocModule,
  );

  // Edit — DRY RUN ONLY，读文件算替换次数不写回
  registry.register(
    {
      name: 'EditPoc',
      description: '编辑文件（P0-5 POC dry-run 版本，只算替换次数）',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['file_path', 'old_text', 'new_text'],
      },
      category: 'fs',
      permissionLevel: 'write',
      readOnly: false,
      allowInPlanMode: true,
    },
    async () => (await import('./file/editPoc')).editPocModule,
  );
}
