// ============================================================================
// CloseAgent (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/closeAgent.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND / DOMAIN_ERROR
// - 行为保真：legacy 输出文案 1:1 复刻（含"already X. No action needed."）
//
// 注意：close_agent 自身的 "abort" 是触发 *目标 sub-agent* 取消，不是中断本工具。
// 工具自身仍走 ctx.abortSignal 闸门保持一致性。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getSpawnGuard } from '../../../agent/spawnGuard';
import { closeAgentSchema as schema } from './closeAgent.schema';
import { withMultiagentMeta } from './resultMeta';
import { getCallerAgentScope, resolveAgentTargetScope } from './agentRunScope';

export async function executeCloseAgent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const agentId = args.agentId;
  if (typeof agentId !== 'string' || !agentId) {
    return { ok: false, error: 'agentId is required', code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const target = resolveAgentTargetScope(ctx, agentId);
  if (target.error) return { ok: false, error: target.error, code: 'NOT_FOUND' };
  const guard = getSpawnGuard();
  const agent = target.scope ? guard.get(agentId, target.scope) : guard.get(agentId);

  if (!agent) {
    return { ok: false, error: `Agent not found: ${agentId}`, code: 'NOT_FOUND' };
  }

  if (agent.status !== 'running') {
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('close_agent done (no-op)', { agentId, status: agent.status });
    return withMultiagentMeta({
      ok: true,
      output: `Agent [${agentId}] is already ${agent.status}. No action needed.`,
    }, ctx, schema.name, {
      action: 'close',
      agentId,
      status: agent.status,
      targets: [agentId],
      counts: { running: guard.getRunningCount(getCallerAgentScope(ctx)) },
      result: { cancelled: false },
    }, `Close agent: ${agentId}`);
  }

  const cancelled = target.scope
    ? guard.cancel(agentId, target.scope)
    : guard.cancel(agentId);
  onProgress?.({ stage: 'completing', percent: 100 });

  if (cancelled) {
    ctx.logger.debug('close_agent done', { agentId, role: agent.role });
    return withMultiagentMeta({
      ok: true,
      output: `Agent [${agentId}] (${agent.role}) cancelled. Running agents: ${guard.getRunningCount(getCallerAgentScope(ctx))}`,
    }, ctx, schema.name, {
      action: 'close',
      agentId,
      status: 'cancelled',
      targets: [agentId],
      counts: { running: guard.getRunningCount(getCallerAgentScope(ctx)) },
      result: { cancelled: true, role: agent.role },
    }, `Close agent: ${agentId}`);
  }
  return {
    ok: false,
    error: `Failed to cancel agent [${agentId}]`,
    code: 'DOMAIN_ERROR',
  };
}

class CloseAgentHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCloseAgent(args, ctx, canUseTool, onProgress);
  }
}

export const closeAgentModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new CloseAgentHandler();
  },
};
