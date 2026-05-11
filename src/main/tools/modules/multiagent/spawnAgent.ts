// ============================================================================
// SpawnAgent / AgentSpawn (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/main/agent/multiagentTools/spawnAgent.ts
//   - spawnAgentTool: Tool / agentSpawnTool: Tool 已删
//   - executeSpawnAgent(params, legacyCtx) 保留作业务函数（接 legacy ToolContext）
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED /
//   DOMAIN_ERROR
// - schema 在 ./spawnAgent.schema.ts，spawn_agent 与 AgentSpawn 共享 inputSchema、
//   description 不同
//
// Opaque service handle 模式（关键样板）：
//   spawn_agent 是 multiagent 中最复杂的——需要 ctx.modelConfig + ctx.resolver +
//   ctx.hookManager + ctx.subagent.* + ctx.workingDir + ctx.sessionId +
//   ctx.currentToolCallId。我们用 buildLegacyCtxFromProtocol 桥接（cross-cat
//   dispatch），保持 932 行 executeSpawnAgent 业务逻辑不动；TODO Wave 4 升
//   SubagentExecutor / ParallelAgentCoordinator 接 ProtocolToolContext 后移除
//   _helpers/legacyAdapter 依赖。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  ToolSchema,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { executeSpawnAgent as executeSpawnAgentLegacy } from '../../../agent/multiagentTools/spawnAgent';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { spawnAgentSchema, agentSpawnSchema } from './spawnAgent.schema';
import { withMultiagentMeta } from './resultMeta';
import { getContextHealthService } from '../../../context/contextHealthService';
import { estimateTokens } from '../../../context/tokenEstimator';

const ROLE_ALIASES: Record<string, string> = {
  explorer: 'explore',
  planner: 'plan',
};

function normalizeRole(role: unknown): unknown {
  if (typeof role !== 'string') return role;
  return ROLE_ALIASES[role] ?? ROLE_ALIASES[role.toLowerCase()] ?? role;
}

function normalizeSpawnArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...args,
    role: normalizeRole(args.role),
  };

  if (Array.isArray(args.agents)) {
    normalized.agents = args.agents.map((agent) => {
      if (!agent || typeof agent !== 'object') return agent;
      const item = agent as Record<string, unknown>;
      return {
        ...item,
        role: normalizeRole(item.role),
      };
    });
  }

  return normalized;
}

async function runSpawnAgent(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress: ToolProgressFn | undefined,
  schemaName: string,
): Promise<ToolResult<string>> {
  const permit = await canUseTool(schemaName, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }
  // Opaque service handle 早判：缺 modelConfig 直接 NOT_INITIALIZED（与 legacy
  // 内部 check_modelConfig 等价但更清晰的错误码）
  if (!ctx.modelConfig) {
    return {
      ok: false,
      error: 'spawn_agent requires modelConfig in context',
      code: 'NOT_INITIALIZED',
    };
  }

  onProgress?.({ stage: 'starting', detail: schemaName });
  const normalizedArgs = normalizeSpawnArgs(args);
  const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
  const legacyResult = await executeSpawnAgentLegacy(normalizedArgs, legacyCtx);
  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug(`${schemaName} done`, { ok: legacyResult.success });
  const result = adaptLegacyResult(legacyResult);
  const legacyAgentId = legacyResult.metadata?.agentId;

  // 上报 subagent 维度 token 贡献（与 task.ts 路径对齐：仅 ok 时累加）
  if (result.ok && typeof result.output === 'string') {
    const subagentName =
      (typeof normalizedArgs.agentId === 'string' && normalizedArgs.agentId) ||
      (typeof legacyAgentId === 'string' && legacyAgentId) ||
      (typeof normalizedArgs.role === 'string' && normalizedArgs.role) ||
      schemaName;
    try {
      getContextHealthService().recordSourceContribution(
        ctx.sessionId,
        { type: 'subagent', name: subagentName },
        estimateTokens(result.output),
        'add',
      );
    } catch (err) {
      ctx.logger.debug('Failed to report spawnAgent subagent token contribution', {
        subagentName,
        err,
      });
    }
  }

  return withMultiagentMeta(result, ctx, schemaName, {
    action: 'spawn',
    status: result.ok ? 'completed' : 'failed',
    agentId: typeof normalizedArgs.agentId === 'string'
      ? normalizedArgs.agentId
      : (typeof legacyAgentId === 'string' ? legacyAgentId : undefined),
    targets: [
      ...(typeof normalizedArgs.role === 'string' ? [normalizedArgs.role] : []),
      ...(Array.isArray(normalizedArgs.agents)
        ? normalizedArgs.agents
          .map((agent) => (agent && typeof agent === 'object' && 'role' in agent ? (agent as { role?: unknown }).role : undefined))
          .filter((role): role is string => typeof role === 'string')
        : []),
    ],
    counts: {
      agents: Array.isArray(normalizedArgs.agents) ? normalizedArgs.agents.length : (typeof normalizedArgs.role === 'string' ? 1 : undefined),
    },
    result: legacyResult.metadata ?? {},
  }, `${schemaName} result`);
}

function makeHandler(schema: ToolSchema): ToolHandler<Record<string, unknown>, string> {
  return {
    schema,
    async execute(args, ctx, canUseTool, onProgress) {
      return runSpawnAgent(args, ctx, canUseTool, onProgress, schema.name);
    },
  };
}

export const spawnAgentModule: ToolModule<Record<string, unknown>, string> = {
  schema: spawnAgentSchema,
  createHandler() {
    return makeHandler(spawnAgentSchema);
  },
};

export const agentSpawnModule: ToolModule<Record<string, unknown>, string> = {
  schema: agentSpawnSchema,
  createHandler() {
    return makeHandler(agentSpawnSchema);
  },
};
