// ============================================================================
// Command Registry - 统一命令注册中心
// ============================================================================

import type { CommandDefinition, CommandSurface, CommandContext, CommandResult } from './types';

export class CommandRegistry {
  private commands: Map<string, CommandDefinition> = new Map();
  private aliasMap: Map<string, string> = new Map();

  /**
   * 注册一个命令定义，同时注册别名
   */
  register(def: CommandDefinition): void {
    this.commands.set(def.id, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliasMap.set(alias, def.id);
      }
    }
  }

  /**
   * 通过 id 或别名获取命令定义
   */
  get(idOrAlias: string): CommandDefinition | undefined {
    const direct = this.commands.get(idOrAlias);
    if (direct) return direct;
    const resolvedId = this.aliasMap.get(idOrAlias);
    if (resolvedId) return this.commands.get(resolvedId);
    return undefined;
  }

  /**
   * 列出所有命令，可按 surface 过滤
   */
  list(surface?: CommandSurface): CommandDefinition[] {
    const all = Array.from(this.commands.values());
    if (!surface) return all;
    return all.filter(cmd => cmd.surfaces.includes(surface));
  }

  /**
   * 模糊搜索命令（匹配 id、name、description）
   */
  search(query: string, surface?: CommandSurface): CommandDefinition[] {
    const lower = query.toLowerCase();
    const candidates = surface ? this.list(surface) : this.list();
    return candidates.filter(cmd =>
      cmd.id.includes(lower) ||
      cmd.name.toLowerCase().includes(lower) ||
      cmd.description.toLowerCase().includes(lower)
    );
  }

  /**
   * 查找并执行命令
   */
  async execute(idOrAlias: string, ctx: CommandContext, args: string[]): Promise<CommandResult> {
    const def = this.get(idOrAlias);
    if (!def) {
      return { success: false, message: `Unknown command: /${idOrAlias}` };
    }
    if (!def.surfaces.includes(ctx.surface)) {
      return { success: false, message: `Command /${def.id} is not available on ${ctx.surface}` };
    }
    try {
      return await def.handler(ctx, args);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: msg };
    }
  }
}

// Singleton
let instance: CommandRegistry | null = null;

export function getCommandRegistry(): CommandRegistry {
  if (!instance) {
    instance = new CommandRegistry();
  }
  return instance;
}
