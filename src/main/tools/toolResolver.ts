// ============================================================================
// Tool Resolver — subagent 使用的工具解析 + dispatch 接口
//
// 历史背景：legacy SubagentContext 持有 toolRegistry: Map<string, Tool>，
// 父 agent 构造 subagent ctx 时把整个 legacy tool 字典拷进去。迁到 protocol
// 之后不再需要 Tool 实例字典，只要：
//   - 知道有哪些 tool（list / getDefinition → LLM tools 列表 + 权限元数据）
//   - 按名字 dispatch（execute → 通过 protocol handler 执行）
//
// 本模块对外暴露 ToolResolver 接口 + 默认实现（单例，走 protocol registry）。
// subagentExecutor / multiagent task / skill / planning.task 拿 resolver 替代
// 原来的 Map<string, Tool>。
// ============================================================================

import type { ToolDefinition } from '../../shared/contract';
import type { ToolContext, ToolExecutionResult } from './types';
import { getProtocolRegistry } from './protocolRegistry';
import { getToolDefinitionWithCloudMeta, getAllToolDefinitions } from './toolDefinitions';
import { buildProtocolContext, buildCanUseToolFromLegacy } from './shadowAdapter';

export interface ToolResolver {
  /** 当前 registry 里所有已注册 tool 的 name */
  list(): string[];
  /** 获取 tool definition（LLM tools 列表 / 权限检查元数据） */
  getDefinition(name: string): ToolDefinition | undefined;
  /** 获取所有 tool definition（全量 snapshot） */
  listDefinitions(): ToolDefinition[];
  /** 判断 tool 是否已注册 */
  has(name: string): boolean;
  /**
   * 按名字 dispatch（通过 protocol handler 执行）。
   * 注意：本入口不过 ToolExecutor 的权限闸门 / 审计 / 缓存，是 subagent 内部
   * 快速执行路径。subagent 已经在 pipeline 层做了权限检查。
   */
  execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult>;
}

class ProtocolToolResolver implements ToolResolver {
  list(): string[] {
    return getProtocolRegistry().getSchemas().map((s) => s.name);
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return getToolDefinitionWithCloudMeta(name);
  }

  listDefinitions(): ToolDefinition[] {
    return getAllToolDefinitions();
  }

  has(name: string): boolean {
    return getProtocolRegistry().has(name);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const registry = getProtocolRegistry();
    if (!registry.has(name)) {
      return { success: false, error: `tool not registered: ${name}` };
    }

    try {
      const handler = await registry.resolve(name);
      const protoCtx = buildProtocolContext({
        sessionId: (ctx as { sessionId?: string }).sessionId,
        workingDirectory: ctx.workingDirectory,
        legacyCtx: ctx,
      });
      const canUseTool = buildCanUseToolFromLegacy(ctx, name);

      const protoResult = await handler.execute(args, protoCtx, canUseTool);
      if (protoResult.ok) {
        const output = typeof protoResult.output === 'string'
          ? protoResult.output
          : JSON.stringify(protoResult.output);
        return {
          success: true,
          output,
          result: protoResult.output,
          metadata: protoResult.meta,
        };
      }
      return {
        success: false,
        error: protoResult.error,
        metadata: { code: protoResult.code, ...(protoResult.meta ?? {}) },
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

let singleton: ToolResolver | null = null;

export function getToolResolver(): ToolResolver {
  if (!singleton) {
    singleton = new ProtocolToolResolver();
  }
  return singleton;
}

/** 测试用：重置单例 */
export function resetToolResolver(): void {
  singleton = null;
}
