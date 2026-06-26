// ============================================================================
// WaitAgent (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/host/agent/multiagentTools/waitAgent.ts (legacy Tool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链：参数校验 / canUseTool / abort / onProgress / 错误码规范化
// - 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_FOUND
// - 行为保真：legacy 状态图标、result.output 1200 字符截断、stats 行 1:1
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
import { waitAgentSchema as schema } from './waitAgent.schema';
import { withMultiagentMeta } from './resultMeta';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;

export async function executeWaitAgent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const agentIds = args.agentIds;
  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return {
      ok: false,
      error: 'agentIds is required and must not be empty',
      code: 'INVALID_ARGS',
    };
  }
  for (const id of agentIds) {
    if (typeof id !== 'string') {
      return {
        ok: false,
        error: 'agentIds must be array of strings',
        code: 'INVALID_ARGS',
      };
    }
  }
  const timeoutMs = Math.min(
    typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const guard = getSpawnGuard();
  const idsTyped = agentIds as string[];

  // Validate all IDs exist
  const missing = idsTyped.filter((id) => !guard.get(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Unknown agent(s): ${missing.join(', ')}`,
      code: 'NOT_FOUND',
    };
  }

  // Wait
  const results = await guard.waitFor(idsTyped, timeoutMs);

  // Format output
  const lines: string[] = [];
  let allDone = true;

  for (const id of idsTyped) {
    const agent = results.get(id);
    if (!agent) {
      lines.push(`[${id}] NOT FOUND`);
      continue;
    }

    const icon = {
      running: '⏳',
      'running-recovered': '⏳',
      'dead-log-only': '📄',
      completed: '✅',
      failed: '❌',
      cancelled: '🚫',
      killed: '🛑',
    }[agent.status];

    const duration = agent.completedAt
      ? `${agent.completedAt - agent.createdAt}ms`
      : 'still running';

    lines.push(`${icon} [${id}] ${agent.role} — ${agent.status} (${duration})`);

    if (agent.status === 'running' || agent.status === 'running-recovered') {
      allDone = false;
      lines.push(`   Still in progress after ${timeoutMs}ms timeout`);
    } else if (agent.result) {
      const output = agent.result.output.slice(0, 1200);
      lines.push(`   Result: ${output}${agent.result.output.length > 1200 ? '...' : ''}`);
      if (agent.result.iterations) {
        lines.push(
          `   Stats: ${agent.result.iterations} iterations, ${agent.result.toolsUsed.length} tools${
            agent.result.cost !== undefined ? `, $${agent.result.cost.toFixed(4)}` : ''
          }`,
        );
      }
    } else if (agent.error) {
      lines.push(`   Error: ${agent.error}`);
    }
  }

  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug('wait_agent done', { agentIds: idsTyped, allDone });

  const agentResults = idsTyped.map((id) => {
    const agent = results.get(id);
    return {
      agentId: id,
      role: agent?.role,
      status: agent?.status ?? 'not_found',
      duration: agent?.completedAt ? agent.completedAt - agent.createdAt : undefined,
      result: agent?.result
        ? {
          output: agent.result.output,
          iterations: agent.result.iterations,
          toolsUsed: agent.result.toolsUsed,
          cost: agent.result.cost,
        }
        : undefined,
      error: agent?.error,
    };
  });

  return withMultiagentMeta({
    ok: true,
    output: `Wait results (${allDone ? 'all done' : 'timeout — some still running'}):\n\n${lines.join('\n')}`,
  }, ctx, schema.name, {
    action: 'wait',
    status: allDone ? 'completed' : 'timeout',
    targets: idsTyped,
    counts: {
      agents: idsTyped.length,
      completed: agentResults.filter((agent) => agent.status === 'completed').length,
      running: agentResults.filter((agent) => agent.status === 'running').length,
      failed: agentResults.filter((agent) => agent.status === 'failed').length,
      cancelled: agentResults.filter((agent) => agent.status === 'cancelled').length,
    },
    duration: timeoutMs,
    result: agentResults,
  }, 'Wait agent results');
}

class WaitAgentHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeWaitAgent(args, ctx, canUseTool, onProgress);
  }
}

export const waitAgentModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new WaitAgentHandler();
  },
};
