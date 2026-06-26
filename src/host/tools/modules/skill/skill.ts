// ============================================================================
// Skill (P0-6.x — native ToolModule rewrite)
//
// 旧版（已删除）: src/host/agent/skillTools/skillMetaTool.ts
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
import { createVirtualArtifact } from '../../artifacts/artifactMeta';
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
  if (skill.allowedTools.length > 0) {
    // GAP-001 限权：所有来源的 skill，allowed-tools 都构成工具边界（边界外强制用户审批）
    contextModifier.toolBoundary = {
      skillName: skill.name,
      allowedTools: skill.allowedTools,
      strict: skill.strictToolset === true,
    };
    // 扩权：仅 builtin/plugin skill 的边界内工具可免审批
    if (canSkillAutoPreApproveTools(skill)) {
      contextModifier.preApprovedTools = skill.allowedTools;
    }
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
      const output =
        `Skill "${skill.name}" completed\n` +
        `Iterations: ${result.iterations}\n` +
        `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
        `Result:\n${result.output}`;
      return {
        ok: true,
        output,
        meta: {
          command: skill.name,
          skillName: skill.name,
          source: skill.source,
          executionContext: skill.executionContext,
          iterations: result.iterations,
          toolsUsed: result.toolsUsed,
          artifact: createVirtualArtifact({
            sourceTool: schema.name,
            kind: 'process-output',
            sessionId: ctx.sessionId,
            name: `skill-${skill.name}-result`,
            mimeType: 'text/plain',
            contentLength: output.length,
            preview: output.slice(0, 500),
            metadata: {
              skillName: skill.name,
              executionContext: skill.executionContext,
              iterations: result.iterations,
              toolsUsed: result.toolsUsed,
            },
          }),
        },
      };
    }
    const partialOutput = result.output ?? '';
    return {
      ok: false,
      error: `Skill "${skill.name}" failed: ${result.error}`,
      meta: {
        command: skill.name,
        skillName: skill.name,
        source: skill.source,
        executionContext: skill.executionContext,
        output: partialOutput,
        iterations: result.iterations,
        toolsUsed: result.toolsUsed,
        artifact: partialOutput
          ? createVirtualArtifact({
              sourceTool: schema.name,
              kind: 'process-output',
              sessionId: ctx.sessionId,
              name: `skill-${skill.name}-partial-result`,
              mimeType: 'text/plain',
              contentLength: partialOutput.length,
              preview: partialOutput.slice(0, 500),
              metadata: {
                skillName: skill.name,
                executionContext: skill.executionContext,
                failed: true,
              },
            })
          : undefined,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Skill execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// ----------------------------------------------------------------------------
// Skill 名称兜底解析
//
// 模型经常把 skill 名记串（例如调用并不存在的 "context"，本意是 context7 或
// context-manifest-pattern）。精确匹配失败时：
//   1. 先做大小写归一 + frontmatter alias 匹配，命中即直接复用，无需模型重试；
//   2. 仍无命中则用编辑距离挑出最接近的候选，回传精简的 "did you mean" 而不是
//      把全部 90+ skill 名甩回去（既省 token，又能引导模型下一轮自我纠正）。
// ----------------------------------------------------------------------------

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase().replace(/^\/+/, '');
}

/** 编辑距离（Levenshtein），用于拼写近似建议 */
function skillEditDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** 通过大小写归一或 frontmatter alias 精确解析 skill（命中即可安全复用）。导出供单测覆盖。 */
export function resolveSkillByNameOrAlias(
  command: string,
  enabledSkills: ParsedSkill[],
): ParsedSkill | undefined {
  const target = normalizeSkillName(command);
  if (!target) return undefined;
  for (const skill of enabledSkills) {
    if (normalizeSkillName(skill.name) === target) return skill;
    const aliases = skill.aliases ?? [];
    if (aliases.some((alias) => normalizeSkillName(alias) === target)) return skill;
  }
  return undefined;
}

/** 返回与 command 最接近的若干 skill 名（子串优先，其次编辑距离 ≤ 3）。导出供单测覆盖。 */
export function suggestClosestSkills(
  command: string,
  enabledSkills: ParsedSkill[],
  limit = 5,
): string[] {
  const target = normalizeSkillName(command);
  if (!target) return [];
  const scored = enabledSkills
    .map((skill) => {
      const name = normalizeSkillName(skill.name);
      const contains = name.includes(target) || target.includes(name);
      const distance = skillEditDistance(target, name);
      // 子串匹配给最高优先级（rank 0），其余按编辑距离排序
      return { name: skill.name, rank: contains ? 0 : distance };
    })
    .filter((s) => s.rank <= 3)
    .sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((s) => s.name);
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

  let skill = discoveryService.getSkill(command);
  let resolvedCommand = command;
  if (!skill) {
    const enabledSkills = discoveryService
      .getAllSkills()
      .filter((s) => discoveryService.isSkillEnabled(s.name));
    // 兜底解析：大小写归一 / alias 命中则直接复用，避免一次无谓的模型重试
    const resolved = resolveSkillByNameOrAlias(command, enabledSkills);
    if (resolved) {
      ctx.logger.info('Skill 名称经兜底解析命中', { requested: command, resolved: resolved.name });
      skill = resolved;
      resolvedCommand = resolved.name;
    } else {
      const suggestions = suggestClosestSkills(command, enabledSkills);
      const hint = suggestions.length
        ? `最接近的可用 skill：${suggestions.join(', ')}`
        : '当前没有可用 skill';
      return {
        ok: false,
        error: `Unknown skill: ${command}。${hint}（完整列表见 设置 → Skills）`,
        code: 'INVALID_ARGS',
      };
    }
  }

  // 全局禁用闸控：被禁用的 skill 对模型和用户都不可调用
  if (!discoveryService.isSkillEnabled(resolvedCommand)) {
    return {
      ok: false,
      error: `Skill "${resolvedCommand}" 已在设置中被禁用。可在 设置 → Skills 中重新启用。`,
      code: 'SKILL_DISABLED',
    };
  }

  if (!isSkillCommandAllowedByWorkbenchScope(resolvedCommand, ctx.toolScope)) {
    return {
      ok: false,
      error: `Skill "${resolvedCommand}" is blocked by the current workbench scope.`,
      code: 'WORKBENCH_SCOPE_DENIED',
      meta: { blockedSkill: resolvedCommand },
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
  const instructionMessage = skillResult.newMessages?.find((message) => message.isMeta)?.content ?? '';

  // 保真 legacy 行为：把 SkillToolResult 通过 meta 透传给 dispatch 层
  if (!skillResult.success) {
    return {
      ok: false,
      error: skillResult.error ?? 'unknown skill error',
      meta: {
        command,
        skillName: skill.name,
        source: skill.source,
        executionContext: skill.executionContext,
        isSkillActivation: true,
        skillResult,
      },
    };
  }
  const output = `Skill "${skill.name}" activated. Follow the skill instructions.`;
  return {
    ok: true,
    output,
    meta: {
      command,
      skillName: skill.name,
      source: skill.source,
      executionContext: skill.executionContext,
      allowedTools: skill.allowedTools,
      loaded: skill.loaded,
      basePath: skill.basePath,
      isSkillActivation: true,
      skillResult,
      artifact: createVirtualArtifact({
        sourceTool: schema.name,
        kind: 'text',
        sessionId: ctx.sessionId,
        name: `skill-${skill.name}-instructions`,
        mimeType: 'text/markdown',
        contentLength: instructionMessage.length || output.length,
        preview: (instructionMessage || output).slice(0, 500),
        metadata: {
          skillName: skill.name,
          source: skill.source,
          executionContext: skill.executionContext,
          allowedTools: skill.allowedTools,
          basePath: skill.basePath,
          isSkillActivation: true,
        },
      }),
    },
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
