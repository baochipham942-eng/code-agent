// ============================================================================
// Skill (P0-6.x — native ToolModule rewrite)
//
// 旧版（已删除）: src/main/agent/skillTools/skillMetaTool.ts
// 改造点：
// - 4 参数签名 (args, ctx, canUseTool, onProgress)
// - inline canUseTool 闸门 + onProgress 事件
// - 走 ctx.logger
// - skill registry 不可达 → NOT_INITIALIZED
// - 行为保真：fork/inline 分发、isMeta 双通道消息、自修补提示完整保留
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import type {
  ParsedSkill,
  SkillMessage,
  SkillToolResult,
  SkillContextModifier,
} from '../../../../shared/contract/agentSkill';
import type { ModelConfig } from '../../../../shared/contract';
import { getSkillDiscoveryService } from '../../../services/skills';
import { renderSkillContent } from '../../../services/skills/skillRenderer';
import { getSubagentExecutor } from '../../../agent/subagentExecutor';
import type { ToolResolver } from '../../dispatch/toolResolver';
import { isSkillCommandAllowedByWorkbenchScope } from '../../workbenchToolScope';
import { skillSchema as schema } from './skill.schema';

// ----------------------------------------------------------------------------
// Helpers — 与 legacy skillMetaTool 行为保真
// ----------------------------------------------------------------------------

function canSkillAutoPreApproveTools(skill: ParsedSkill): boolean {
  // Local project/user/library skills are editable content and cannot escalate
  // directly into no-approval tool grants. Builtin/plugin skills are shipped as
  // trusted capabilities in this runtime.
  return skill.source === 'builtin' || skill.source === 'plugin';
}

function handleInlineExecution(
  skill: ParsedSkill,
  args: string | undefined,
  workingDirectory: string | undefined,
): SkillToolResult {
  const statusMessage = `<command-message>Loading skill: ${skill.name}</command-message><command-name>${skill.name}</command-name>`;

  let promptContent = renderSkillContent(skill.promptContent, {
    arguments: args,
    workingDirectory,
  });
  if (args) {
    promptContent += `\n\n---\nUser provided arguments: ${args}`;
  }

  // 对 user/project skill 注入自修补引导
  if (skill.source === 'user' || skill.source === 'project') {
    promptContent += `\n\n---\n**自修补**: 如果发现本 skill 的指令过时或有错误（工具名变化、路径错误、逻辑缺陷），直接用 Edit 修改 \`${skill.basePath}/SKILL.md\` 的相应部分。修改后系统自动重载。`;
  }

  const newMessages: SkillMessage[] = [
    {
      role: 'user',
      content: statusMessage,
      isMeta: false,
    },
    {
      role: 'user',
      content: promptContent,
      isMeta: true,
    },
  ];

  const contextModifier: SkillContextModifier = {};
  if (skill.allowedTools.length > 0 && canSkillAutoPreApproveTools(skill)) {
    contextModifier.preApprovedTools = skill.allowedTools;
  }
  if (skill.model) {
    contextModifier.modelOverride = skill.model;
  }

  return {
    success: true,
    data: { commandName: skill.name },
    newMessages,
    contextModifier,
  };
}

async function handleForkExecution(
  skill: ParsedSkill,
  args: string | undefined,
  ctx: ToolContext,
): Promise<ToolResult<string>> {
  if (!ctx.modelConfig) {
    return {
      ok: false,
      error: 'Subagent context not available for fork execution mode',
      code: 'NOT_INITIALIZED',
    };
  }

  let fullPrompt = renderSkillContent(skill.promptContent, {
    arguments: args,
    workingDirectory: ctx.workingDir,
  });
  if (args) {
    fullPrompt += `\n\n---\nUser request: ${args}`;
  }

  try {
    const executor = getSubagentExecutor();
    const result = await executor.execute(
      fullPrompt,
      {
        name: `Skill:${skill.name}`,
        systemPrompt: `You are executing the "${skill.name}" skill. ${skill.description}. Follow the instructions carefully.`,
        availableTools: skill.allowedTools,
        maxIterations: 15,
      },
      {
        modelConfig: ctx.modelConfig as ModelConfig,
        toolResolver: ctx.resolver as ToolResolver,
        // 兼容 legacy 字段：subagentExecutor 期望旧 ToolContext，这里 cast 一层
        // 由于 protocol 层只有 opaque service handle，把 ctx 直接透传，executor 内部按需取字段
        toolContext: ctx as never,
      },
    );

    if (result.success) {
      return {
        ok: true,
        output:
          `Skill "${skill.name}" completed\n` +
          `Iterations: ${result.iterations}\n` +
          `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
          `Result:\n${result.output}`,
      };
    }
    return {
      ok: false,
      error: `Skill "${skill.name}" failed: ${result.error}`,
      meta: { output: result.output },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Skill execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// ----------------------------------------------------------------------------
// Native execute
// ----------------------------------------------------------------------------

export async function executeSkill(
  args: Record<string, unknown>,
  ctx: ToolContext,
  canUseTool: CanUseToolFn,
  onProgress?: ToolProgressFn,
): Promise<ToolResult<string>> {
  const command = args.command;
  if (typeof command !== 'string' || command.length === 0) {
    return { ok: false, error: 'command must be a non-empty string', code: 'INVALID_ARGS' };
  }
  const skillArgs = typeof args.args === 'string' ? args.args : undefined;

  const permit = await canUseTool(schema.name, args);
  if (!permit.allow) {
    return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
  }
  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  onProgress?.({ stage: 'starting', detail: `skill ${command}` });

  const discoveryService = getSkillDiscoveryService();
  if (!discoveryService) {
    return { ok: false, error: 'Skill discovery service is not available.', code: 'NOT_INITIALIZED' };
  }

  try {
    await discoveryService.ensureInitialized(ctx.workingDir || process.cwd());
    ctx.logger.info('SkillDiscoveryService ready for execution', {
      workingDirectory: discoveryService.getWorkingDirectory(),
    });
  } catch (error) {
    ctx.logger.error('Failed to initialize SkillDiscoveryService on demand', { error });
    return {
      ok: false,
      error: `Skill 系统初始化失败: ${error instanceof Error ? error.message : String(error)}`,
      code: 'NOT_INITIALIZED',
    };
  }

  const skill = discoveryService.getSkill(command);
  if (!skill) {
    const available = discoveryService
      .getAllSkills()
      .map((s) => s.name)
      .join(', ');
    return {
      ok: false,
      error: `Unknown skill: ${command}. Available skills: ${available || 'none'}`,
      code: 'INVALID_ARGS',
    };
  }

  if (!isSkillCommandAllowedByWorkbenchScope(command, ctx.toolScope)) {
    return {
      ok: false,
      error: `Skill "${command}" is blocked by the current workbench scope.`,
      code: 'WORKBENCH_SCOPE_DENIED',
      meta: { blockedSkill: command },
    };
  }

  // Lazy load skill content if not loaded yet
  if (!skill.loaded) {
    const { loadSkillContent } = await import('../../../services/skills/skillLoader');
    await loadSkillContent(skill);
  }

  ctx.logger.info('Executing skill', {
    name: skill.name,
    source: skill.source,
    executionContext: skill.executionContext,
  });

  // 记录 skill 使用（异步，不阻塞执行）
  import('../../../services/skills/skillUsageTracker')
    .then(({ recordSkillUsage }) => recordSkillUsage(skill.name, skill.source))
    .catch(() => { /* 追踪失败不影响执行 */ });

  if (ctx.abortSignal.aborted) {
    return { ok: false, error: 'aborted', code: 'ABORTED' };
  }

  // 根据执行模式分发
  if (skill.executionContext === 'fork') {
    const result = await handleForkExecution(skill, skillArgs, ctx);
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.info('Skill done', { command, ok: result.ok });
    return result;
  }

  // inline 模式
  const skillResult = handleInlineExecution(skill, skillArgs, ctx.workingDir);
  onProgress?.({ stage: 'completing', percent: 100 });
  ctx.logger.info('Skill done', { command, ok: skillResult.success });

  // 保真 legacy 行为：把 SkillToolResult 通过 meta 透传给 dispatch 层
  if (!skillResult.success) {
    return {
      ok: false,
      error: skillResult.error ?? 'unknown skill error',
      meta: { skillResult, isSkillActivation: true },
    };
  }
  return {
    ok: true,
    output: `Skill "${skill.name}" activated. Follow the skill instructions.`,
    meta: { skillResult, isSkillActivation: true },
  };
}

class SkillHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<string>> {
    return executeSkill(args, ctx, canUseTool, onProgress);
  }
}

export const skillModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() {
    return new SkillHandler();
  },
};
