// ============================================================================
// Legacy ToolContext Adapter — 给 wrapper 模式的 V2 工具用
//
// 在批量迁移期，部分工具暂用 "wrapper" 模式：V2 module 委托给 legacy Tool 实现，
// 只做 4 参数签名 + canUseTool + ctx 字段映射。这个 helper 把新 ProtocolToolContext
// 桥接成 legacy ToolContext（cast，因为字段集差异完全 opaque）。
//
// 用法：
//   const legacyCtx = buildLegacyCtxFromProtocol(ctx);
//   const result = await legacyTool.execute(args, legacyCtx);
//   return adaptLegacyResult(result);
//
// 全量迁完后，wrapper 工具可以陆续改成 native 实现，删除这个 adapter。
// ============================================================================

import type {
  ToolContext as ProtocolToolContext,
  ToolResult as ProtocolToolResult,
} from '../../../protocol/tools';
import type { ToolContext as LegacyToolContext, ToolExecutionResult } from '../../types';

/**
 * 构造 legacy ToolContext，把新 ctx 字段映射回旧字段
 * legacyToolRegistry/planningService/modelConfig 等 opaque 字段从 ctx 直传
 */
export function buildLegacyCtxFromProtocol(ctx: ProtocolToolContext): LegacyToolContext {
  // 把 protocol AgentEvent 透传成 legacy emitEvent (string, data)
  const wrapEmit = (event: string, data: unknown) => {
    ctx.emit({ type: event, ...((data && typeof data === 'object') ? data : { data }) } as never);
  };

  return {
    workingDirectory: ctx.workingDir,
    requestPermission: async () => true, // wrapper 已经过 canUseTool 闸门，这里直放行
    sessionId: ctx.sessionId,
    emit: wrapEmit,
    emitEvent: wrapEmit,
    // P0-5 ctx 扩展字段反向映射回 legacy
    toolRegistry: ctx.legacyToolRegistry as LegacyToolContext['toolRegistry'],
    modelConfig: ctx.modelConfig,
    hookManager: ctx.hookManager as LegacyToolContext['hookManager'],
    planningService: ctx.planningService,
    modelCallback: ctx.modelCallback,
    currentToolCallId: ctx.currentToolCallId,
    // subagent snapshot 字段
    agentId: ctx.subagent?.agentId,
    agentName: ctx.subagent?.agentName,
    agentRole: ctx.subagent?.agentRole,
    messages: ctx.subagent?.messages as LegacyToolContext['messages'],
    modifiedFiles: ctx.subagent?.modifiedFiles as LegacyToolContext['modifiedFiles'],
    todos: ctx.subagent?.todos as LegacyToolContext['todos'],
    currentAttachments: ctx.subagent?.attachments as LegacyToolContext['currentAttachments'],
    // setPlanMode/isPlanMode 桥回 legacy 函数对
    setPlanMode: ctx.planMode ? (active: boolean) => {
      if (active) ctx.planMode!.enter();
      else ctx.planMode!.exit();
    } : undefined,
    isPlanMode: ctx.planMode ? () => ctx.planMode!.isActive() : undefined,
  } as LegacyToolContext;
}

/**
 * 把 legacy ToolExecutionResult 适配成新 ProtocolToolResult
 * 旧 success → ok，旧 output → output（string），meta 透传
 */
export function adaptLegacyResult(result: ToolExecutionResult): ProtocolToolResult<string> {
  if (result.success) {
    return {
      ok: true,
      output: result.output ?? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '')),
      meta: result.metadata,
    };
  }
  return {
    ok: false,
    error: result.error ?? 'unknown error',
    meta: result.metadata,
  };
}
