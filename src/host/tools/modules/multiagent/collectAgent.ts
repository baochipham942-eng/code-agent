// ============================================================================
// collect_agent — 取后台子 agent 的状态/结果（Kimi 借鉴 #2 / ADR-025 A1）
// ============================================================================
// 配合 spawn_agent 的 run_in_background：后台 spawn 返回稳定 agent_id（subagent-bg-N），
// 之后用 collect_agent 凭该 id 查状态、（默认）等待完成并取最终输出。
//
// 读进程内 BackgroundSubagentRegistry（A1 不跨重启）；与走 SpawnGuard 的
// wait_agent 是不同源——后台 detached agent 是独立概念，故独立 collect 路径。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { getBackgroundSubagentRegistry } from '../../../agent/backgroundSubagentRegistry';
import { withMultiagentMeta } from './resultMeta';
import { collectAgentSchema } from './collectAgent.schema';

export { collectAgentSchema };

export async function executeCollectAgent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const agentId = args.agentId;
  if (typeof agentId !== 'string' || !agentId) {
    return { ok: false, error: 'agentId is required', code: 'INVALID_ARGS' };
  }
  const shouldWait = args.wait !== false; // 默认等待

  const permit = await canUseTool(collectAgentSchema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }

  const registry = getBackgroundSubagentRegistry();
  if (!registry.getStatus(agentId)) {
    return { ok: false, error: `Unknown background agent: ${agentId}`, code: 'NOT_FOUND' };
  }

  onProgress?.({ stage: 'starting', detail: collectAgentSchema.name });
  if (shouldWait) {
    await registry.await(agentId);
  }
  const handle = registry.getStatus(agentId);
  if (!handle) {
    return { ok: false, error: `Unknown background agent: ${agentId}`, code: 'NOT_FOUND' };
  }
  onProgress?.({ stage: 'completing', percent: 100 });

  const icon = { running: '⏳', completed: '✅', failed: '❌' }[handle.status];
  const lines = [`${icon} [${handle.agentId}] ${handle.status}`];
  if (handle.status === 'completed' && handle.result) {
    lines.push(`Result: ${handle.result.output}`);
  } else if (handle.status === 'failed') {
    lines.push(`Error: ${handle.error ?? 'unknown error'}`);
  } else {
    lines.push('Still running in the background.');
  }

  return withMultiagentMeta(
    { ok: true, output: lines.join('\n') },
    ctx,
    collectAgentSchema.name,
    {
      action: 'collect',
      status: handle.status,
      agentId: handle.agentId,
      declaredOutputs: handle.declaredOutputs,
      result: { background: true, output: handle.result?.output, error: handle.error },
    },
    'Collect agent result',
  );
}

class CollectAgentHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = collectAgentSchema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeCollectAgent(args, ctx, canUseTool, onProgress);
  }
}

export const collectAgentModule: ToolModule<Record<string, unknown>, string> = {
  schema: collectAgentSchema,
  createHandler() {
    return new CollectAgentHandler();
  },
};
