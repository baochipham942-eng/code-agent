// ============================================================================
// Explore (P1 Wave 3 — planning: native ToolModule rewrite, cross-cat dispatch)
//
// 旧版: src/main/agent/multiagentTools/explore.ts (legacy Tool exploreTool)
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - 五链 + 错误码：INVALID_ARGS / PERMISSION_DENIED / ABORTED / DOMAIN_ERROR
// - 行为保真：4 个 hardcoded subagent (explore/bash/plan/code-review) /
//   run_in_background 占位 / 缺 modelConfig fallback /
//   "✅ <Name> agent completed" + Iterations + Tools used + Result 1:1
//
// Cross-cat partial native (合理委托)：
//   SubagentExecutor 当前接 legacy ToolContext，本工具用
//   buildLegacyCtxFromProtocol 桥接 — 与 multiagent#104 的 task / spawn_agent /
//   workflow_orchestrate 同模式。**Wave 4 把 SubagentExecutor 升 ProtocolToolContext
//   后可彻底移除 _helpers/legacyAdapter 依赖**。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type { ModelConfig } from '../../../../shared/contract';
import type { ToolResolver } from '../../dispatch/toolResolver';
import { getSubagentExecutor } from '../../../agent/subagentExecutor';
import { createLogger } from '../../../services/infra/logger';
import { buildLegacyCtxFromProtocol } from '../_helpers/legacyAdapter';
import { exploreSchema as schema } from './explore.schema';

const logger = createLogger('ExploreTool');

const SUBAGENT_TYPES = {
  explore: {
    id: 'explore',
    name: 'Explore',
    description: 'Fast agent for exploring codebases',
    systemPrompt: `You are a codebase exploration assistant. Your job is to quickly find and understand code.

When exploring:
1. Use glob to find files by pattern
2. Use grep to search for specific content
3. Use read_file to examine file contents
4. Use list_directory to understand structure

Be efficient - find the most relevant information quickly and summarize your findings clearly.`,
    availableTools: ['glob', 'grep', 'read_file', 'list_directory'],
    maxIterations: 10,
  },
  bash: {
    id: 'bash',
    name: 'Bash',
    description: 'Command execution specialist',
    systemPrompt: `You are a command-line execution assistant. Execute shell commands safely and report results.

Guidelines:
1. Be careful with destructive commands
2. Check command output for errors
3. Provide clear summaries of what happened
4. If a command fails, explain why and suggest fixes`,
    availableTools: ['bash'],
    maxIterations: 5,
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    description: 'Software architect for designing implementation plans',
    systemPrompt: `You are a software architect. Your job is to design implementation plans.

When planning:
1. First explore the codebase to understand existing patterns
2. Identify the files that need to be created or modified
3. Break down the task into clear, actionable steps
4. Consider edge cases and error handling
5. Note any dependencies or prerequisites

Provide a structured plan with:
- Overview of the approach
- Step-by-step implementation guide
- Files to create/modify
- Potential risks or considerations`,
    availableTools: ['glob', 'grep', 'read_file', 'list_directory'],
    maxIterations: 10,
  },
  'code-review': {
    id: 'code-review',
    name: 'Code Reviewer',
    description: 'Reviews code for bugs, security issues, and best practices',
    systemPrompt: `You are a code review assistant. Review code thoroughly for:

1. Bugs and logic errors
2. Security vulnerabilities
3. Performance issues
4. Code style and readability
5. Best practices violations

Provide specific feedback with file and line references when possible.`,
    availableTools: ['glob', 'grep', 'read_file'],
    maxIterations: 10,
  },
} as const;

type SubagentType = keyof typeof SUBAGENT_TYPES;

export async function executeExplore(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const prompt = args.prompt as string | undefined;
  const subagentType = (args.subagent_type as SubagentType | undefined) || 'explore';
  const runInBackground = (args.run_in_background as boolean) || false;

  if (!prompt || typeof prompt !== 'string') {
    return {
      ok: false,
      error: 'prompt is required and must be a string',
      code: 'INVALID_ARGS',
    };
  }

  const subagentConfig = SUBAGENT_TYPES[subagentType];
  if (!subagentConfig) {
    return {
      ok: false,
      error: `Unknown subagent type: ${subagentType}. Available: ${Object.keys(SUBAGENT_TYPES).join(', ')}`,
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

  // Background execution not yet supported (legacy 也未实现)
  if (runInBackground) {
    const taskId = `task-${Date.now()}`;
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output:
        `Task delegated to ${subagentConfig.name} agent (background).\n` +
        `Task ID: ${taskId}\n` +
        `Prompt: ${prompt}\n` +
        `Status: Background execution not yet implemented - task queued`,
    };
  }

  // 缺 modelConfig fallback：legacy 行为是返回成功 + 提示文案
  if (!ctx.modelConfig) {
    onProgress?.({ stage: 'completing', percent: 100 });
    return {
      ok: true,
      output:
        `Task: ${subagentConfig.name}\n` +
        `Description: ${subagentConfig.description}\n` +
        `Available tools: ${subagentConfig.availableTools.join(', ')}\n\n` +
        `Prompt: ${prompt}\n\n` +
        `(Subagent context not available - execute manually)`,
    };
  }

  logger.info('Starting subagent execution', { subagentType });

  try {
    const executor = getSubagentExecutor();

    // Cross-cat 桥接：SubagentExecutor 接 legacy ToolContext
    // TODO Wave 4: SubagentExecutor 升 ProtocolToolContext 后移除 legacyAdapter
    const legacyCtx = buildLegacyCtxFromProtocol(ctx, canUseTool);

    const result = await executor.execute(
      prompt,
      {
        name: subagentConfig.name,
        systemPrompt: subagentConfig.systemPrompt,
        availableTools: [...subagentConfig.availableTools],
        maxIterations: subagentConfig.maxIterations,
      },
      {
        modelConfig: ctx.modelConfig as ModelConfig,
        toolResolver: ctx.resolver as ToolResolver,
        toolContext: legacyCtx,
      },
    );

    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('Explore done', { subagentType, ok: result.success });

    if (result.success) {
      return {
        ok: true,
        output:
          `✅ ${subagentConfig.name} agent completed\n` +
          `Iterations: ${result.iterations}\n` +
          `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
          `Result:\n${result.output}`,
      };
    }
    return {
      ok: false,
      error: `${subagentConfig.name} agent failed: ${result.error}`,
      code: 'DOMAIN_ERROR',
      meta: result.output ? { output: result.output } : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Subagent execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      code: 'DOMAIN_ERROR',
    };
  }
}

class ExploreHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeExplore(args, ctx, canUseTool, onProgress);
  }
}

export const exploreModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new ExploreHandler();
  },
};
