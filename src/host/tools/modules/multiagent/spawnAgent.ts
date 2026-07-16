// ============================================================================
// SpawnAgent / AgentSpawn (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 业务执行由 protocol-native spawn service 承担。
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED /
//   DOMAIN_ERROR
// - schema 在 ./spawnAgent.schema.ts，spawn_agent 与 AgentSpawn 共享 inputSchema、
//   description 不同
//
// Protocol context 在入口一次性投影为显式 execution ports。
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
import { executeSpawnAgent } from '../../../agent/multiagentTools/spawnAgent';
import { createProtocolSubagentExecutionContext } from '../../../agent/subagentExecutionContext';
import type { SubagentExecutionContext } from '../../../agent/subagentExecutorTypes';
import type { ToolResolver } from '../../dispatch/toolResolver';
import { spawnAgentSchema, agentSpawnSchema } from './spawnAgent.schema';
import { withMultiagentMeta } from './resultMeta';
import { getContextHealthService } from '../../../context/contextHealthService';
import { estimateTokens } from '../../../context/tokenEstimator';
import { getBackgroundSubagentRegistry } from '../../../agent/backgroundSubagentRegistry';
import { scheduleBackgroundSubagentIdleWake } from '../../../agent/backgroundSubagentIdleWake';
import type { SubagentResult } from '../../../agent/subagentExecutorTypes';
import {
  AgentFailureCode,
  inferAgentFailureCode,
} from '../../../../shared/contract/agentFailure';

function getDeclaredOutputsForRole(role: string | undefined): string[] | undefined {
  if (!role) return undefined;
  try {
    // 只走 agentRegistry 模块加载时注册的进程内 provider——顶层 createRequire(import.meta.url)
    // 在 CJS bundle 里 import.meta.url 为 undefined，模块加载即炸（PR#417 CI 实锤）。
    const globalRegistry = (globalThis as typeof globalThis & {
      codeAgentAgentRegistry?: {
        resolveAgent?: (id: string) => { outputs?: string[] } | undefined;
      };
    }).codeAgentAgentRegistry;
    const outputs = globalRegistry?.resolveAgent?.(role)?.outputs;
    return outputs && outputs.length > 0 ? outputs : undefined;
  } catch {
    return undefined;
  }
}

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

  const agents: unknown = args.agents;
  if (Array.isArray(agents)) {
    normalized.agents = agents.map((agent: unknown) => {
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
    return {
      ok: false,
      error: `permission denied: ${permit.reason}`,
      code: 'PERMISSION_DENIED',
      meta: { failureCode: AgentFailureCode.PermissionDenied },
    };
  }
  if (ctx.abortSignal.aborted) {
    return {
      ok: false,
      error: 'aborted',
      code: 'ABORTED',
      meta: { failureCode: AgentFailureCode.CancelledByUser },
    };
  }
  // Opaque service handle 早判：缺 modelConfig 直接 NOT_INITIALIZED（与 legacy
  // 内部 check_modelConfig 等价但更清晰的错误码）
  if (!ctx.modelConfig) {
    return {
      ok: false,
      error: 'spawn_agent requires modelConfig in context',
      code: 'NOT_INITIALIZED',
      meta: { failureCode: AgentFailureCode.ModelError },
    };
  }

  onProgress?.({ stage: 'starting', detail: schemaName });
  const normalizedArgs = normalizeSpawnArgs(args);
  let executionContext: SubagentExecutionContext;
  try {
    executionContext = createProtocolSubagentExecutionContext(ctx, canUseTool, {
      resolver: ctx.resolver as ToolResolver | undefined,
      progress: (stage, detail, percent) => onProgress?.({ stage, detail, percent }),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      code: 'NOT_INITIALIZED',
      meta: { failureCode: AgentFailureCode.ModelError },
    };
  }

  // ADR-025 A1：后台执行——立即返回稳定 agent_id 不阻塞前台 turn。
  // 关键：后台子 agent 用**独立 AbortController**，否则父 turn 结束触发的
  // abort 会连带杀掉后台任务，"后台"语义就破了。进程内 only（不跨重启 resume）。
  if (args.run_in_background === true) {
    const bgController = new AbortController();
    const backgroundRole = typeof normalizedArgs.role === 'string' ? normalizedArgs.role : undefined;
    const declaredOutputs = getDeclaredOutputsForRole(backgroundRole);
    const agentId = getBackgroundSubagentRegistry().spawn(async (): Promise<SubagentResult> => {
      const bgResult = await executeSpawnAgent(normalizedArgs, {
        ...executionContext,
        abortSignal: bgController.signal,
        // 后台子 agent 标 async_agent（2026-07-13 拍板）：bash 走 ask+forceConfirm
        executionTopology: 'async_agent',
      });
      const failureCode = bgResult.success ? undefined : inferAgentFailureCode({
        failureCode: bgResult.metadata?.failureCode,
        error: bgResult.error,
        defaultCode: AgentFailureCode.ModelError,
      });
      return {
        success: bgResult.success,
        output: bgResult.success && typeof bgResult.output === 'string' ? bgResult.output : '',
        error: bgResult.success ? undefined : bgResult.error,
        toolsUsed: [],
        iterations: 0,
        ...(failureCode ? { failureCode } : {}),
      };
    }, {
      sessionId: ctx.sessionId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.swarmRunScope?.treeId ?? ctx.spawnTreeId
        ? { treeId: ctx.swarmRunScope?.treeId ?? ctx.spawnTreeId }
        : {}),
      role: backgroundRole,
      declaredOutputs,
      suppressIdleWake: Boolean(ctx.suppressBackgroundSubagentIdleWake),
      ...(ctx.suppressBackgroundSubagentIdleWake ? { suppressReason: 'goal-loop' as const } : {}),
      onComplete: scheduleBackgroundSubagentIdleWake,
    });
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug(`${schemaName} spawned in background`, { agentId });
    return withMultiagentMeta(
      {
        ok: true,
        output: `已在后台启动子 agent（agent_id: ${agentId}），前台不阻塞。用该 agent_id 查询状态或获取最终结果。`,
      },
      ctx,
      schemaName,
      { action: 'spawn', status: 'running', agentId, declaredOutputs, result: { background: true } },
      `${schemaName} background`,
    );
  }

  const serviceResult = await executeSpawnAgent(normalizedArgs, executionContext);
  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug(`${schemaName} done`, { ok: serviceResult.success });
  const result: ToolResult<string> = serviceResult.success
    ? { ok: true, output: serviceResult.output ?? '', meta: serviceResult.metadata }
    : { ok: false, error: serviceResult.error ?? 'unknown error', meta: serviceResult.metadata };
  const serviceAgentId = serviceResult.metadata?.agentId;

  // 上报 subagent 维度 token 贡献（与 task.ts 路径对齐：仅 ok 时累加）
  if (result.ok && typeof result.output === 'string') {
    const subagentName =
      (typeof normalizedArgs.agentId === 'string' && normalizedArgs.agentId) ||
      (typeof serviceAgentId === 'string' && serviceAgentId) ||
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
      : (typeof serviceAgentId === 'string' ? serviceAgentId : undefined),
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
    result: serviceResult.metadata ?? {},
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
