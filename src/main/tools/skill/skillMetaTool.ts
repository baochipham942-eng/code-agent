// ============================================================================
// Skill Meta Tool - Agent Skills Standard
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type {
  ParsedSkill,
  SkillMessage,
  SkillToolResult,
  SkillContextModifier,
} from '../../../shared/types/agentSkill';
import { getSkillDiscoveryService } from '../../services/skills';
import { getSubagentExecutor } from '../../agent/subagentExecutor';
import type { ModelConfig } from '../../../shared/types';
import { createLogger } from '../../services/infra/logger';

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
 * 动态生成工具描述，包含可用 Skills 列表
 */
function generateDescription(): string {
  const discoveryService = getSkillDiscoveryService();

  // 如果服务未初始化，返回基础描述
  if (!discoveryService.isInitialized()) {
    return `Execute a skill within the main conversation.

Use this tool to invoke skills. Skills are loaded from:
- ~/.claude/skills/ (user skills)
- .claude/skills/ (project skills)
- Built-in skills

Note: Skills not yet loaded. They will be available after initialization.`;
  }

  const skills = discoveryService.getSkillsForContext();

  if (skills.length === 0) {
    return `Execute a skill within the main conversation.

No skills currently available. Add skills to:
- ~/.claude/skills/ (user skills)
- .claude/skills/ (project skills)`;
  }

  // 构建 XML 格式的 skills 列表
  const skillsXml = skills
    .map(
      (s) =>
        `  <skill>
    <name>${escapeXml(s.name)}</name>
    <description>${escapeXml(s.description)}</description>
  </skill>`
    )
    .join('\n');

  return `Execute a skill within the main conversation.

When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

When users ask you to run a "slash command" or reference "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke the corresponding skill.

<available_skills>
${skillsXml}
</available_skills>

Important:
- When a skill is relevant, invoke it immediately as your first action
- Only use skills listed above
- Do not use this tool for built-in CLI commands`;
}

/**
 * 处理 inline 执行模式
 */
function handleInlineExecution(skill: ParsedSkill, args?: string): SkillToolResult {
  // 构建可见的状态消息
  const statusMessage = `<command-message>Loading skill: ${skill.name}</command-message><command-name>${skill.name}</command-name>`;

  // 构建 skill prompt（包含参数）
  let promptContent = skill.promptContent;
  if (args) {
    promptContent += `\n\n---\nUser provided arguments: ${args}`;
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
  if (!context.toolRegistry || !context.modelConfig) {
    return {
      success: false,
      error: 'Subagent context not available for fork execution mode',
    };
  }

  // 构建完整的 prompt
  let fullPrompt = skill.promptContent;
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
        toolRegistry: new Map(
          context.toolRegistry.getAllTools().map((t) => [t.name, t])
        ),
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
  name: 'skill',
  description: generateDescription(),
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The skill name to execute (e.g., "commit", "code-review")',
      },
      args: {
        type: 'string',
        description: 'Optional arguments or context for the skill',
      },
    },
    required: ['command'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const command = params.command as string;
    const args = params.args as string | undefined;

    // 获取 skill
    const discoveryService = getSkillDiscoveryService();
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

    logger.info('Executing skill', {
      name: skill.name,
      source: skill.source,
      executionContext: skill.executionContext,
    });

    // 根据执行模式分发
    if (skill.executionContext === 'fork') {
      return handleForkExecution(skill, args, context);
    }

    // inline 模式
    const skillResult = handleInlineExecution(skill, args);

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
  return generateDescription();
}
