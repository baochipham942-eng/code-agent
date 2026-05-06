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
  const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);
  const legacyResult = await executeSpawnAgentLegacy(args, legacyCtx);
  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.debug(`${schemaName} done`, { ok: legacyResult.success });
  return adaptLegacyResult(legacyResult);
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
