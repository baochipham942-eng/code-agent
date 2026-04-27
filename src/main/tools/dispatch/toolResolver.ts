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
//
// 2026-04-27 从 protocol/dispatch/ 搬到 tools/dispatch/，因为 dispatch 全部是
// runtime 逻辑，违反 protocol/ "只放类型和常量" 约束。
// ============================================================================

import type { ToolDefinition } from '../../../shared/contract';
import type { ToolContext, ToolExecutionResult } from '../types';
import { getProtocolRegistry } from '../protocolRegistry';
import { getToolDefinitionWithCloudMeta, getAllToolDefinitions } from './toolDefinitions';
import { buildProtocolContext, buildCanUseToolFromLegacy } from './shadowAdapter';
import { isToolNameAllowedByWorkbenchScope } from '../workbenchToolScope';
import { getMCPClient } from '../../mcp';

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
    return this.listDefinitions().map((definition) => definition.name);
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return getToolDefinitionWithCloudMeta(name);
  }

  listDefinitions(): ToolDefinition[] {
    return getAllToolDefinitions();
  }

  has(name: string): boolean {
    return this.getDefinition(name) !== undefined;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const registry = getProtocolRegistry();
    const definition = this.getDefinition(name);
    if (!definition) {
      return { success: false, error: `tool not registered: ${name}` };
    }
    const dispatchName = definition.name;

    if (!isToolNameAllowedByWorkbenchScope(dispatchName, ctx.toolScope)) {
      return {
        success: false,
        error: `tool blocked by current workbench scope: ${dispatchName}`,
        metadata: { code: 'WORKBENCH_SCOPE_DENIED' },
      };
    }

    try {
      const mcpClient = getMCPClient();
      const mcpToolName = mcpClient.parseMCPToolName(dispatchName);
      if (mcpToolName) {
        const result = await mcpClient.callTool(
          ctx.currentToolCallId ?? `mcp-${Date.now()}`,
          mcpToolName.serverName,
          mcpToolName.toolName,
          args,
          { abortSignal: ctx.abortSignal },
        );
        return {
          success: result.success,
          output: result.output,
          error: result.error,
          outputPath: result.outputPath,
          result: result.output,
          metadata: {
            ...(result.metadata ?? {}),
            serverName: mcpToolName.serverName,
            toolName: mcpToolName.toolName,
            duration: result.duration,
          },
        };
      }

      if (!registry.has(dispatchName)) {
        return { success: false, error: `tool not registered: ${dispatchName}` };
      }

      const handler = await registry.resolve(dispatchName);
      const protoCtx = buildProtocolContext({
        sessionId: (ctx as { sessionId?: string }).sessionId,
        workingDirectory: ctx.workingDirectory,
        legacyCtx: ctx,
        abortSignal: ctx.abortSignal,
        resolver: this,
      });
      const canUseTool = buildCanUseToolFromLegacy(ctx, dispatchName);

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
