// ============================================================================
// Tool Registry
//
// 三段式查询链（参考 Claude Code CLI 2.1.88 leaked tools.ts 的 getAllBaseTools
// / getTools / assembleToolPool / filterToolsByDenyRules）：
//   register(schema, loader)  —— 启动时填充 schemas Map + loaders Map
//   getSchemas() / getSchemasForMode() —— 不加载 handler，只返回 schema
//   resolve(name) —— 首次调用时执行 loader，缓存 handler 实例
//
// 与旧 ToolRegistry (src/main/tools/registry/toolRegistry.ts 之类) 并存。旧系统
// 不动，新路径由 modules/index.ts 的 registerMigratedTools() 统一注册。
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
