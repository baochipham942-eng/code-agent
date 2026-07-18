// ============================================================================
// SendInput (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/sendInput.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND /
//   DOMAIN_ERROR
// - 行为保真：legacy "Message queued..." 文案 1:1，含两路 fallback：
//   1. SpawnGuard 中 running agent → guard.sendMessage
//   2. SpawnGuard miss 但 ParallelAgentCoordinator 有 → coordinator.sendMessage
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
import {
  getParallelAgentCoordinator,
  getParallelAgentCoordinatorRegistry,
} from '../../../agent/parallelAgentCoordinator';
import { sendInputSchema as schema } from './sendInput.schema';
import { withMultiagentMeta } from './resultMeta';
import { resolveAgentTargetScope } from './agentRunScope';

export async function executeSendInput(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const agentId = args.agentId;
  const message = args.message;
  if (typeof agentId !== 'string' || !agentId || typeof message !== 'string' || !message) {
    return {
      ok: false,
      error: 'agentId and message are required',
      code: 'INVALID_ARGS',
    };
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
    const coordinator = target.scope
      ? getParallelAgentCoordinatorRegistry().get(target.scope)
      : getParallelAgentCoordinator();
    const sentToParallelAgent = await coordinator?.sendMessage(agentId, message) ?? false;
    if (sentToParallelAgent) {
      onProgress?.({ stage: 'completing', percent: 100 });
      return withMultiagentMeta({
        ok: true,
        output: `Message queued for parallel agent [${agentId}]. It will be delivered at the start of the next iteration.`,
      }, ctx, schema.name, {
        action: 'send',
        agentId,
        status: 'queued',
        targets: [agentId],
        counts: { bytes: message.length },
        result: { queued: true, route: 'parallel' },
      }, `Send input: ${agentId}`);
    }
    return { ok: false, error: `Agent not found: ${agentId}`, code: 'NOT_FOUND' };
  }

  if (agent.status !== 'running') {
    return {
      ok: false,
      error: `Agent [${agentId}] is not running (status: ${agent.status}). Cannot send input to a finished agent.`,
      code: 'DOMAIN_ERROR',
    };
  }

  const sent = target.scope
    ? guard.sendMessage(agentId, message, target.scope)
    : guard.sendMessage(agentId, message);
  onProgress?.({ stage: 'completing', percent: 100 });
  if (sent) {
    ctx.logger.debug('send_input done', { agentId, role: agent.role });
    return withMultiagentMeta({
      ok: true,
      output: `Message queued for agent [${agentId}] (${agent.role}). It will be delivered at the start of the next iteration.`,
    }, ctx, schema.name, {
      action: 'send',
      agentId,
      status: 'queued',
      targets: [agentId],
      counts: { bytes: message.length },
      result: { queued: true, route: 'spawnGuard', role: agent.role },
    }, `Send input: ${agentId}`);
  }
  return {
    ok: false,
    error: `Failed to send message to agent [${agentId}]`,
    code: 'DOMAIN_ERROR',
  };
}

class SendInputHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeSendInput(args, ctx, canUseTool, onProgress);
  }
}

export const sendInputModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SendInputHandler();
  },
};
