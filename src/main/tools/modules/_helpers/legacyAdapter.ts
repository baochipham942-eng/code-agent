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
  ToolHandler,
  ToolModule,
  ToolSchema,
  ToolCategory,
  PermissionLevel,
  CanUseToolFn,
  CanUseToolResult,
  ToolProgressFn,
} from '../../../protocol/tools';
import type {
  Tool,
  ToolContext as LegacyToolContext,
  ToolExecutionResult,
  PermissionRequestData,
} from '../../types';

/**
 * 构造 legacy ToolContext，把新 ctx 字段映射回旧字段
 * legacyToolRegistry/planningService/modelConfig 等 opaque 字段从 ctx 直传
 */
async function forwardLegacyPermissionRequest(
  request: PermissionRequestData,
  canUseTool?: CanUseToolFn,
): Promise<boolean> {
  if (!canUseTool) {
    return false;
  }

  const reason = request.type === 'dangerous_command' && request.reason
    ? `dangerous:${request.reason}`
    : request.reason;

  const result: CanUseToolResult = await canUseTool(
    request.tool,
    request.details ?? {},
    reason,
    request,
  );
  return result.allow;
}

export function buildLegacyCtxFromProtocol(
  ctx: ProtocolToolContext,
  canUseTool?: CanUseToolFn,
): LegacyToolContext {
  // 把 protocol AgentEvent 透传成 legacy emitEvent (string, data)
  const wrapEmit = (event: string, data: unknown) => {
    ctx.emit({ type: event, ...((data && typeof data === 'object') ? data : { data }) } as never);
  };

  return {
    workingDirectory: ctx.workingDir,
    requestPermission: (request) => forwardLegacyPermissionRequest(request, canUseTool),
    abortSignal: ctx.abortSignal,
    sessionId: ctx.sessionId,
    emit: wrapEmit,
    emitEvent: wrapEmit,
    // P0-5 ctx 扩展字段反向映射回 legacy
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
    // 跨工具调度 resolver — 由 shadowAdapter 在 protocol ctx 构造时注入
    resolver: ctx.resolver,
    toolScope: ctx.toolScope,
    executionIntent: ctx.executionIntent,
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

// ----------------------------------------------------------------------------
// wrapLegacyTool factory — 通用 wrapper 工厂
//
// 把 legacy Tool 包成 ToolModule。批量迁移期所有 wrapper 类工具直接复用，
// 不需要每个工具写一遍 4 参数样板。
// ----------------------------------------------------------------------------

export interface WrapOptions {
  category: ToolCategory;
  permissionLevel: PermissionLevel;
  readOnly?: boolean;
  allowInPlanMode?: boolean;
}

export function wrapLegacyTool(legacyTool: Tool, opts: WrapOptions): ToolModule {
  const schema: ToolSchema = {
    name: legacyTool.name,
    description: legacyTool.description,
    inputSchema: legacyTool.inputSchema,
    category: opts.category,
    permissionLevel: opts.permissionLevel,
    readOnly: opts.readOnly ?? false,
    allowInPlanMode: opts.allowInPlanMode ?? false,
    // 透传 legacy 动态描述生成器（bash/webSearch/skillMeta 依赖它）
    ...(legacyTool.dynamicDescription ? { dynamicDescription: legacyTool.dynamicDescription } : {}),
  };

  class Handler implements ToolHandler<Record<string, unknown>, string> {
    readonly schema = schema;

    async execute(
      args: Record<string, unknown>,
      ctx: ProtocolToolContext,
      canUseTool: CanUseToolFn,
      onProgress?: ToolProgressFn,
    ): Promise<ProtocolToolResult<string>> {
      const permit = await canUseTool(schema.name, args);
      if (!permit.allow) {
        return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
      }
      if (ctx.abortSignal.aborted) {
        return { ok: false, error: 'aborted', code: 'ABORTED' };
      }

      onProgress?.({ stage: 'starting', detail: legacyTool.name });
      const legacyResult = await legacyTool.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
      onProgress?.({ stage: 'completing', percent: 100 });
      ctx.logger.debug(`${legacyTool.name} done`, { ok: legacyResult.success });
      return adaptLegacyResult(legacyResult);
    }
  }

  return {
    schema,
    createHandler() {
      return new Handler();
    },
  };
}
