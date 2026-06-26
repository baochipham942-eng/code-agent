// ============================================================================
// AgentMessage (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/agentMessage.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND
// - 行为保真：list/status/result/cancel 四 action 输出 1:1 复刻 legacy
// - 共享 listSpawnedAgents / getSpawnedAgent helpers（保留在 legacy spawnAgent.ts）
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getSpawnedAgent, listSpawnedAgents } from '../../../agent/multiagentTools/spawnAgent';
import { getSpawnGuard } from '../../../agent/spawnGuard';
import { agentMessageSchema as schema } from './agentMessage.schema';
import { withMultiagentMeta } from './resultMeta';

type MessageAction = 'status' | 'list' | 'result' | 'cancel';
const VALID_ACTIONS: readonly MessageAction[] = ['status', 'list', 'result', 'cancel'];

export async function executeAgentMessage(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const action = args.action;
  if (typeof action !== 'string' || !VALID_ACTIONS.includes(action as MessageAction)) {
    return {
      ok: false,
      error: `Unknown action: ${String(action)}`,
      code: 'INVALID_ARGS',
    };
  }
  const agentId = typeof args.agentId === 'string' ? args.agentId : undefined;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const result = ((): ToolResult<string> => {
    switch (action as MessageAction) {
      case 'list': {
        const agents = listSpawnedAgents();
        if (agents.length === 0) {
          const output = 'No agents have been spawned in this session.';
          return withMultiagentMeta(
            { ok: true, output },
            ctx,
            schema.name,
            { action, status: 'empty', agents: [], counts: { agents: 0 } },
            'Spawned agents',
          );
        }
        const agentList = agents
          .map((a) => {
            const statusIcon =
              ({
                idle: '⏸️',
                running: '🔄',
                'running-recovered': '🔄',
                'dead-log-only': '📄',
                completed: '✅',
                failed: '❌',
                killed: '🛑',
              } as const)[a.status];
            return `${statusIcon} [${a.id}] ${a.role} - ${a.status}
   Task: ${a.task?.substring(0, 50)}${(a.task?.length || 0) > 50 ? '...' : ''}`;
          })
          .join('\n\n');
        const output = `Spawned Agents (${agents.length}):\n\n${agentList}`;
        return withMultiagentMeta(
          { ok: true, output },
          ctx,
          schema.name,
          {
            action,
            status: 'listed',
            agents,
            targets: agents.map((a) => a.id),
            counts: {
              agents: agents.length,
              running: agents.filter((a) => a.status === 'running').length,
              completed: agents.filter((a) => a.status === 'completed').length,
              failed: agents.filter((a) => a.status === 'failed').length,
            },
          },
          'Spawned agents',
        );
      }

      case 'status': {
        if (!agentId) return { ok: false, error: 'agentId required for status action', code: 'INVALID_ARGS' };
        const agent = getSpawnedAgent(agentId);
        if (!agent) return { ok: false, error: `Agent not found: ${agentId}`, code: 'NOT_FOUND' };
        return withMultiagentMeta({
          ok: true,
          output: `Agent Status:
- ID: ${agent.id}
- Role: ${agent.role}
- Status: ${agent.status}
- Task: ${agent.task}
${agent.error ? `- Error: ${agent.error}` : ''}
${agent.result ? `- Has Result: Yes (use action='result' to retrieve)` : ''}`,
        }, ctx, schema.name, {
          action,
          agentId,
          status: agent.status,
          targets: [agentId],
          result: {
            role: agent.role,
            task: agent.task,
            hasResult: Boolean(agent.result),
            error: agent.error,
          },
        }, `Agent status: ${agentId}`);
      }

      case 'result': {
        if (!agentId) return { ok: false, error: 'agentId required for result action', code: 'INVALID_ARGS' };
        const agent = getSpawnedAgent(agentId);
        if (!agent) return { ok: false, error: `Agent not found: ${agentId}`, code: 'NOT_FOUND' };
        if (agent.status === 'running') {
          return withMultiagentMeta(
            { ok: true, output: `Agent [${agentId}] is still running. Check back later.` },
            ctx,
            schema.name,
            { action, agentId, status: agent.status, targets: [agentId], result: { ready: false } },
            `Agent result: ${agentId}`,
          );
        }
        if (agent.status === 'failed') {
          return { ok: false, error: `Agent [${agentId}] failed: ${agent.error ?? 'unknown'}`, code: 'DOMAIN_ERROR' };
        }
        return withMultiagentMeta({
          ok: true,
          output: `Agent [${agentId}] Result:

Task: ${agent.task}

Output:
${agent.result || '(no output)'}`,
        }, ctx, schema.name, {
          action,
          agentId,
          status: agent.status,
          targets: [agentId],
          result: {
            task: agent.task,
            output: agent.result || '',
          },
        }, `Agent result: ${agentId}`);
      }

      case 'cancel': {
        if (!agentId) return { ok: false, error: 'agentId required for cancel action', code: 'INVALID_ARGS' };
        const guard = getSpawnGuard();
        const managed = guard.get(agentId);
        if (!managed) return { ok: false, error: `Agent not found: ${agentId}`, code: 'NOT_FOUND' };
        if (managed.status !== 'running') {
          return withMultiagentMeta({
            ok: true,
            output: `Agent [${agentId}] is not running (status: ${managed.status})`,
          }, ctx, schema.name, {
            action,
            agentId,
            status: managed.status,
            targets: [agentId],
            result: { cancelled: false },
          }, `Agent cancel: ${agentId}`);
        }
        guard.cancel(agentId);
        return withMultiagentMeta(
          { ok: true, output: `Agent [${agentId}] cancelled via abort signal.` },
          ctx,
          schema.name,
          { action, agentId, status: 'cancelled', targets: [agentId], result: { cancelled: true } },
          `Agent cancel: ${agentId}`,
        );
      }
    }
  })();

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('agent_message done', { action, agentId, ok: result.ok });
  return result;
}

class AgentMessageHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeAgentMessage(args, ctx, canUseTool, onProgress);
  }
}

export const agentMessageModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new AgentMessageHandler();
  },
};
