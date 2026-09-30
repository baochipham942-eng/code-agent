// ============================================================================
// SendInput (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/sendInput.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND /
//   DOMAIN_ERROR
// - 行为保真：legacy "Message queued..." 文案 1:1，含两路：
//   1. 协调器还能收（含同时挂在 SpawnGuard 上的成员）→ 只走 durable 账本
//   2. 仅 SpawnGuard 在跑 → guard.sendMessage
//   外部引擎运行中拒收。已完成节点残留的 pending 如实报未送达，不再当成找不到人。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { AgentEngineKind } from '../../../../shared/contract/agentEngine';
import type { SwarmRunScope } from '../../../../shared/contract/swarm';
import { getSubagentEngine } from '../../../agent/agentDefinition';
import { getSpawnGuard } from '../../../agent/spawnGuard';
import { mintToolMessageOrigin } from '../../../agent/messageOrigin';
import {
  getParallelAgentCoordinator,
  getParallelAgentCoordinatorRegistry,
  type ParallelAgentCoordinator,
} from '../../../agent/parallelAgentCoordinator';
import { LEGACY_COORDINATOR_SCOPE } from '../../../agent/parallelAgentCoordinatorTypes';
import {
  externalEngineFollowUpFailure,
  resolveMemberEngine,
  undeliveredFollowUpFailure,
} from '../../../agent/memberRuntimeEngine';
import { peekMemberInputQueues } from '../../../agent/memberInputWindDown';
import { sendInputSchema as schema } from './sendInput.schema';
import { withMultiagentMeta } from './resultMeta';
import { resolveAgentTargetScope } from './agentRunScope';

function coordinatorFor(scope: SwarmRunScope | undefined, createLegacy: boolean): ParallelAgentCoordinator | undefined {
  const registry = getParallelAgentCoordinatorRegistry();
  if (scope) return registry.get(scope);
  return createLegacy ? getParallelAgentCoordinator() : registry.get(LEGACY_COORDINATOR_SCOPE);
}

function rejectIfExternalEngine(
  agentId: string,
  roleId: string | undefined,
  engine: AgentEngineKind | undefined,
): ToolResult<string> | null {
  const failure = externalEngineFollowUpFailure(resolveMemberEngine({
    agentId,
    engine: engine ?? (roleId ? getSubagentEngine(roleId) : undefined),
  }));
  if (!failure) return null;
  return { ok: false, error: failure.message, code: 'DOMAIN_ERROR' };
}

function queuedParallelResult(ctx: ToolContext, agentId: string, message: string): ToolResult<string> {
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
  // ADR-067 D1：来源由宿主从 ctx 铸造——子代理内执行是 peer-agent（带真实
  // senderAgentId），主代理执行是 orchestrator；落队不再是硬编码的 'user'/'parent'。
  const messageOrigin = mintToolMessageOrigin(ctx);

  if (!agent) {
    const coordinator = coordinatorFor(target.scope, !target.scope);
    if (coordinator?.canReceiveMessage(agentId)) {
      const task = coordinator.getTaskDefinition(agentId);
      const rejected = rejectIfExternalEngine(agentId, task?.role, task?.engine);
      if (rejected) return rejected;
      const sentToParallelAgent = await coordinator.sendMessage(agentId, message, messageOrigin);
      if (sentToParallelAgent) {
        onProgress?.({ stage: 'completing', percent: 100 });
        return queuedParallelResult(ctx, agentId, message);
      }
    }
    const leftover = undeliveredFollowUpFailure(peekMemberInputQueues(agentId, target.scope).length);
    if (leftover) return { ok: false, error: leftover.message, code: 'DOMAIN_ERROR' };
    return { ok: false, error: `Agent not found: ${agentId}`, code: 'NOT_FOUND' };
  }

  if (agent.status !== 'running') {
    const leftover = undeliveredFollowUpFailure(peekMemberInputQueues(agentId, target.scope).length);
    if (leftover) return { ok: false, error: leftover.message, code: 'DOMAIN_ERROR' };
    return {
      ok: false,
      error: `Agent [${agentId}] is not running (status: ${agent.status}). Cannot send input to a finished agent.`,
      code: 'DOMAIN_ERROR',
    };
  }

  const liveCoordinator = coordinatorFor(target.scope, false);
  if (liveCoordinator?.canReceiveMessage(agentId)) {
    const task = liveCoordinator.getTaskDefinition(agentId);
    const rejected = rejectIfExternalEngine(agentId, task?.role ?? agent.role, task?.engine);
    if (rejected) return rejected;
    const sentToParallelAgent = await liveCoordinator.sendMessage(agentId, message, messageOrigin);
    if (!sentToParallelAgent) {
      return { ok: false, error: `Failed to send message to agent [${agentId}]`, code: 'DOMAIN_ERROR' };
    }
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('send_input done', { agentId, role: agent.role, route: 'parallel' });
    return queuedParallelResult(ctx, agentId, message);
  }

  const rejected = rejectIfExternalEngine(agentId, agent.role, undefined);
  if (rejected) return rejected;

  const sent = target.scope
    ? guard.sendMessage(agentId, message, target.scope, messageOrigin)
    : guard.sendMessage(agentId, message, undefined, messageOrigin);
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
