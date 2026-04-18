// ============================================================================
// Skill Meta Tool - Agent Skills Standard
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../../tools/types';
import type {
  ParsedSkill,
  SkillMessage,
  SkillToolResult,
  SkillContextModifier,
} from '../../../shared/contract/agentSkill';
import { getSkillDiscoveryService } from '../../services/skills';
import { getSubagentExecutor } from '../subagentExecutor';
import type { ToolResolver } from '../../protocol/dispatch/toolResolver';
import { renderSkillContent } from '../../services/skills/skillRenderer';
import type { ModelConfig } from '../../../shared/contract';
import { createLogger } from '../../services/infra/logger';
import { isSkillCommandAllowedByWorkbenchScope } from '../../tools/workbenchToolScope';
import {
  SKILL_DESCRIPTION,
  SKILL_INPUT_SCHEMA,
} from '../../tools/modules/skill/skill.schema';

const logger = createLogger('SkillMetaTool');

/**
 * XML 转义函数
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 动态生成 skill 工具描述
 * 聚合所有可用 skill 的 name + description 到工具描述中
 * 对标 Anthropic 的 <available_skills> 机制
 */
function buildSkillDescription(): string {
  const discoveryService = getSkillDiscoveryService();
  const skills = discoveryService.isInitialized()
    ? discoveryService.getSkillsForContext()
    : [];

  let desc = `执行已注册的 skill。使用方式：skill({ command: "skill_name", args: "可选参数" })`;

  if (skills.length > 0) {
    const CHAR_BUDGET = 2000;
    let used = 0;
    const lines: string[] = [];

    for (const s of skills) {
      const line = `- "${s.name}": ${s.description}`;
      if (used + line.length > CHAR_BUDGET) break;
      lines.push(line);
      used += line.length;
    }

    desc += `\n\n可用 skills:\n${lines.join('\n')}`;
  }

  return desc;
}

/**
 * 处理 inline 执行模式
 */
function handleInlineExecution(skill: ParsedSkill, args?: string, workingDirectory?: string): SkillToolResult {
  // 构建可见的状态消息
  const statusMessage = `<command-message>Loading skill: ${skill.name}</command-message><command-name>${skill.name}</command-name>`;

  // Render skill content: process !cmd and $ARGUMENTS
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

  // 构建注入消息
  const newMessages: SkillMessage[] = [
    {
      role: 'user',
      content: statusMessage,
      isMeta: false, // 用户可见
    },
    {
      role: 'user',
      content: promptContent,
      isMeta: true, // 用户不可见，但发送给模型
    },
  ];

  // 构建上下文修改器
  const contextModifier: SkillContextModifier = {
    preApprovedTools: skill.allowedTools,
  };

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

/**
 * 处理 fork 执行模式（使用 Subagent）
 */
async function handleForkExecution(
  skill: ParsedSkill,
  args: string | undefined,
  context: ToolContext
): Promise<ToolExecutionResult> {
  // 检查是否有执行 subagent 所需的上下文
  if (!context.modelConfig) {
    return {
      success: false,
      error: 'Subagent context not available for fork execution mode',
    };
  }

  // Render skill content: process !cmd and $ARGUMENTS, then build prompt
  let fullPrompt = renderSkillContent(skill.promptContent, {
    arguments: args,
    workingDirectory: context.workingDirectory,
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
        modelConfig: context.modelConfig as ModelConfig,
        toolResolver: context.resolver as ToolResolver,
        toolContext: context,
      }
    );

    if (result.success) {
      return {
        success: true,
        output:
          `Skill "${skill.name}" completed\n` +
          `Iterations: ${result.iterations}\n` +
          `Tools used: ${result.toolsUsed.join(', ') || 'none'}\n\n` +
          `Result:\n${result.output}`,
      };
    } else {
      return {
        success: false,
        error: `Skill "${skill.name}" failed: ${result.error}`,
        output: result.output,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: `Skill execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Skill 元工具
 *
 * 与旧的 skillTool 的主要区别：
 * 1. 支持 Agent Skills 标准的 SKILL.md 格式
 * 2. inline 模式通过消息注入执行，而非 subagent 隔离
 * 3. 支持 allowed-tools 预授权机制
 * 4. 支持 isMeta 双通道消息
 */
export const skillMetaTool: Tool = {
  name: 'Skill',
  description: SKILL_DESCRIPTION,
  dynamicDescription: buildSkillDescription,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: SKILL_INPUT_SCHEMA,

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const command = params.command as string;
    const args = params.args as string | undefined;

    // 获取 skill（确保服务已初始化）
    const discoveryService = getSkillDiscoveryService();

    try {
      await discoveryService.ensureInitialized(context.workingDirectory || process.cwd());
      logger.info('SkillDiscoveryService ready for execution', {
        workingDirectory: discoveryService.getWorkingDirectory(),
      });
    } catch (error) {
      logger.error('Failed to initialize SkillDiscoveryService on demand', { error });
      return {
        success: false,
        error: `Skill 系统初始化失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const skill = discoveryService.getSkill(command);

    if (!skill) {
      const available = discoveryService
        .getAllSkills()
        .map((s) => s.name)
        .join(', ');
      return {
        success: false,
        error: `Unknown skill: ${command}. Available skills: ${available || 'none'}`,
      };
    }

    if (!isSkillCommandAllowedByWorkbenchScope(command, context.toolScope)) {
      return {
        success: false,
        error: `Skill "${command}" is blocked by the current workbench scope.`,
        metadata: {
          code: 'WORKBENCH_SCOPE_DENIED',
          blockedSkill: command,
        },
      };
    }

    // Lazy load skill content if not loaded yet
    if (!skill.loaded) {
      const { loadSkillContent } = await import('../../services/skills/skillLoader');
      await loadSkillContent(skill);
    }

    logger.info('Executing skill', {
      name: skill.name,
      source: skill.source,
      executionContext: skill.executionContext,
    });

    // 记录 skill 使用（异步，不阻塞执行）
    import('../../services/skills/skillUsageTracker')
      .then(({ recordSkillUsage }) => recordSkillUsage(skill.name, skill.source))
      .catch(() => { /* 追踪失败不影响执行 */ });

    // 根据执行模式分发
    if (skill.executionContext === 'fork') {
      return handleForkExecution(skill, args, context);
    }

    // inline 模式
    const skillResult = handleInlineExecution(skill, args, context.workingDirectory);

    // 将 SkillToolResult 转换为 ToolExecutionResult
    // 通过 metadata 传递 newMessages 和 contextModifier
    return {
      success: skillResult.success,
      error: skillResult.error,
      output: `Skill "${skill.name}" activated. Follow the skill instructions.`,
      metadata: {
        skillResult,
        isSkillActivation: true,
      },
    };
  },
};

/**
 * 获取动态生成的工具描述
 * 用于需要刷新描述的场景
 */
export function getSkillToolDescription(): string {
  return buildSkillDescription();
}
