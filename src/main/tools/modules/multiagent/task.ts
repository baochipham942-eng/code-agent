// ============================================================================
// Task (P1 Wave 3 — multiagent: native ToolModule rewrite)
//
// 旧版: src/main/agent/multiagentTools/task.ts (legacy Tool sdkTaskTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / NOT_INITIALIZED /
//   DOMAIN_ERROR
// - 行为保真：parseAndValidateTaskParams（XML/quote 修复 + 模糊匹配）/
//   taskDeduplication / SubagentContextBuilder / 模型回退 / 输出文案 1:1
//
// Opaque service handle 模式（关键样板）：
//   task 用 ctx.modelConfig (cast ModelConfig) + ctx.resolver (cast ToolResolver)
//   + ctx.hookManager (opaque) + ctx.subagent?.messages/todos/modifiedFiles +
//   ctx.sessionId + ctx.currentToolCallId。这些都是 ProtocolToolContext 已结构化
//   或 opaque 字段，protocol 层无需扩展。
//
// Cross-cat 桥接：SubagentExecutor 接 legacy ToolContext，本工具用
//   buildLegacyCtxFromProtocol 桥接。等 Wave 4 把 SubagentExecutor 升到
//   ProtocolToolContext 后可移除 _helpers/legacyAdapter 依赖。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { ModelConfig, Message } from '../../../../shared/contract';
import type { ToolResolver } from '../../dispatch/toolResolver';
import { getSubagentExecutor } from '../../../agent/subagentExecutor';
import {
  getPredefinedAgent,
  listPredefinedAgents,
  getAgentPrompt,
  getAgentTools,
  getAgentDynamicMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
  getSubagentModelConfig,
  CORE_AGENT_IDS,
  isCoreAgent,
} from '../../../agent/agentDefinition';
import { taskDeduplication } from '../../../agent/taskDeduplication';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
  type TodoItem,
} from '../../../agent/subagentContextBuilder';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { taskSchema as schema } from './task.schema';
import { withMultiagentMeta } from './resultMeta';

// ----------------------------------------------------------------------------
// 参数验证（与 legacy parseAndValidateTaskParams 对齐）
// ----------------------------------------------------------------------------

interface TaskParams {
  subagent_type: string;
  prompt: string;
  description?: string;
}

type TaskParamsResult =
  | { success: true; params: TaskParams }
  | { success: false; error: string };

function extractSubagentType(params: Record<string, unknown>): string | undefined {
  if (params.subagent_type && typeof params.subagent_type === 'string') {
    return params.subagent_type;
  }
  for (const key of Object.keys(params)) {
    if (key.startsWith('subagent_type')) {
      const match = key.match(/subagent_type[=:]["']?([^"'<>\s]+)/);
      if (match) return match[1];
    }
  }
  return undefined;
}

function findSimilarAgentType(input: string, validTypes: string[]): string | undefined {
  const inputLower = input.toLowerCase();
  for (const type of validTypes) {
    if (type.includes(inputLower) || inputLower.includes(type)) return type;
  }
  for (const type of validTypes) {
    if (type[0] === inputLower[0] && Math.abs(type.length - inputLower.length) <= 2) return type;
  }
  return undefined;
}

function parseAndValidateTaskParams(params: Record<string, unknown>): TaskParamsResult {
  let subagentType = extractSubagentType(params);
  const prompt = params.prompt as string | undefined;
  const description = params.description as string | undefined;

  if (typeof subagentType === 'string') {
    subagentType = subagentType.replace(/<[^>]*>/g, '').trim();
    subagentType = subagentType.replace(/^["']|["']$/g, '');
    subagentType = subagentType.trim();
  }

  if (!subagentType || typeof subagentType !== 'string') {
    return {
      success: false,
      error: `Missing subagent_type parameter. Valid types: ${CORE_AGENT_IDS.join(', ')}`,
    };
  }

  if (!isCoreAgent(subagentType)) {
    const suggestion = findSimilarAgentType(subagentType, [...CORE_AGENT_IDS]);
    const suggestionText = suggestion ? ` Did you mean "${suggestion}"?` : '';
    return {
      success: false,
      error: `Invalid subagent_type: "${subagentType}".${suggestionText} Valid types: ${CORE_AGENT_IDS.join(', ')}`,
    };
  }

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { success: false, error: 'Missing or empty prompt parameter' };
  }

  return {
    success: true,
    params: {
      subagent_type: subagentType,
      prompt: prompt.trim(),
      description: description?.trim(),
    },
  };
}

// ----------------------------------------------------------------------------
// Native execute
// ----------------------------------------------------------------------------

export async function executeTask(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const validation = parseAndValidateTaskParams(args);
  if (!validation.success) {
    return { ok: false, error: validation.error, code: 'INVALID_ARGS' };
  }

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: schema.name });

  const { subagent_type: subagentType, prompt, description } = validation.params;

  // P1: 任务去重
  const dupCheck = taskDeduplication.isDuplicate(subagentType, prompt);
  if (dupCheck.isDuplicate) {
    if (dupCheck.cachedResult) {
      onProgress?.({ stage: 'completing', percent: 100 });
      return withMultiagentMeta(
        { ok: true, output: `[缓存结果] ${dupCheck.cachedResult}` },
        ctx,
        schema.name,
        {
          action: 'task',
          status: 'cached',
          agentId: subagentType,
          targets: [subagentType],
          result: { output: dupCheck.cachedResult },
        },
        {
          artifactName: `Task result: ${subagentType}`,
          requestArgs: args,
        },
      );
    }
    return {
      ok: false,
      error: dupCheck.reason || '相同任务已在执行中，请等待完成',
      code: 'DOMAIN_ERROR',
    };
  }

  const taskHash = taskDeduplication.registerTask(subagentType, prompt);

  // Opaque service handle: ctx.modelConfig
  if (!ctx.modelConfig) {
    taskDeduplication.failTask(taskHash);
    return {
      ok: false,
      error: 'Task requires modelConfig in context',
      code: 'NOT_INITIALIZED',
    };
  }

  const agentConfig = getPredefinedAgent(subagentType);
  if (!agentConfig) {
    taskDeduplication.failTask(taskHash);
    const availableIds = listPredefinedAgents().map((a) => a.id);
    return {
      ok: false,
      error: `Unknown agent type: ${subagentType}. Available: ${availableIds.join(', ')}`,
      code: 'INVALID_ARGS',
    };
  }

  const agentName = agentConfig.name;
  let systemPrompt = getAgentPrompt(agentConfig);
  const tools = getAgentTools(agentConfig);
  const maxIterations = getAgentDynamicMaxIterations(agentConfig, prompt);
  const permissionPreset = getAgentPermissionPreset(agentConfig);
  const maxBudget = getAgentMaxBudget(agentConfig);

  // ── Subagent 上下文注入（与 legacy 等价）─────────────────────────────────
  try {
    const contextLevel = getAgentContextLevel(subagentType);
    const subagentMessages = ctx.subagent?.messages as Message[] | undefined;
    if (subagentMessages && subagentMessages.length > 0) {
      const contextBuilder = new SubagentContextBuilder({
        sessionId: ctx.sessionId || 'unknown',
        messages: subagentMessages,
        contextLevel,
        todos: ctx.subagent?.todos as TodoItem[] | undefined,
        modifiedFiles: ctx.subagent?.modifiedFiles as Set<string> | undefined,
      });
      const subagentContext = await contextBuilder.build(prompt);
      const contextPrompt = contextBuilder.formatForSystemPrompt(subagentContext);
      if (contextPrompt) {
        systemPrompt = systemPrompt + contextPrompt;
      }
    }
  } catch (err) {
    console.warn('[Task] Failed to inject subagent context:', err);
  }

  // P4: 子代理专用模型配置
  const subagentModelConfig = getSubagentModelConfig(subagentType);
  const effectiveModelConfig: ModelConfig = {
    ...(ctx.modelConfig as ModelConfig),
    provider: subagentModelConfig.provider,
    model: subagentModelConfig.model,
  };

  try {
    const executor = getSubagentExecutor();

    // Cross-cat 桥接：SubagentExecutor 接 legacy ToolContext，用 helper 桥
    // TODO Wave 4: SubagentExecutor 升 ProtocolToolContext 后移除 legacyAdapter
    const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);

    const result = await executor.execute(
      prompt,
      {
        name: agentName,
        systemPrompt,
        availableTools: tools,
        maxIterations,
        permissionPreset,
        maxBudget,
      },
      {
        modelConfig: effectiveModelConfig,
        toolResolver: ctx.resolver as ToolResolver,
        toolContext: legacyCtx,
        parentToolUseId: ctx.currentToolCallId,
        hookManager: ctx.hookManager as Parameters<typeof executor.execute>[2]['hookManager'],
      },
    );

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('task done', { subagentType, ok: result.success });

    if (result.success) {
      const output = `Agent [${agentName}] completed${description ? ` (${description})` : ''}:

${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}${result.cost !== undefined ? `\n- Cost: $${result.cost.toFixed(4)}` : ''}`;

      taskDeduplication.completeTask(taskHash, result.output);
      return withMultiagentMeta(
        { ok: true, output },
        ctx,
        schema.name,
        {
          action: 'task',
          status: 'completed',
          agentId: subagentType,
          targets: [subagentType],
          counts: {
            iterations: result.iterations,
            tools: result.toolsUsed.length,
          },
          result: {
            agentName,
            subagentType,
            description,
            output: result.output,
            iterations: result.iterations,
            toolsUsed: result.toolsUsed,
            cost: result.cost,
          },
        },
        {
          artifactName: `Task result: ${subagentType}`,
          requestArgs: args,
        },
      );
    }
    taskDeduplication.failTask(taskHash);
    return withMultiagentMeta({
      ok: false,
      error: `Agent [${agentName}] failed: ${result.error ?? 'unknown error'}`,
      code: 'DOMAIN_ERROR',
      meta: result.output ? { output: result.output } : undefined,
    }, ctx, schema.name, {
      action: 'task',
      status: 'failed',
      agentId: subagentType,
      targets: [subagentType],
      counts: {
        iterations: result.iterations,
        tools: result.toolsUsed.length,
      },
      result: {
        agentName,
        subagentType,
        description,
        output: result.output,
        error: result.error,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
        cost: result.cost,
      },
    }, {
      requestArgs: args,
    });
  } catch (error) {
    taskDeduplication.failTask(taskHash);
    return {
      ok: false,
      error: `Task execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class TaskHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeTask(args, ctx, canUseTool, onProgress);
  }
}

export const taskModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new TaskHandler();
  },
};
