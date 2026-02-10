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
 * 生成 skill 工具的简化描述
 * 不再嵌入完整 skill 列表，通过 tool_search 发现具体 skills
 */
function generateDescription(): string {
  return `执行已注册的 skill。

Skills 是专业化的任务能力，如 commit、review-pr、test 等。

**发现 skills**：使用 tool_search("+skill") 或 tool_search("commit") 搜索可用 skills。

**使用方式**：skill({ command: "skill_name", args: "可选参数" })

Skills 来源：
- ~/.claude/skills/ (用户 skills)
- .claude/skills/ (项目 skills)
- 内置 skills`;
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

    // 获取 skill（确保服务已初始化）
    const discoveryService = getSkillDiscoveryService();

    // 如果服务未初始化，先初始化
    if (!discoveryService.isInitialized()) {
      logger.warn('SkillDiscoveryService not initialized, initializing now...');
      try {
        await discoveryService.initialize(context.workingDirectory || process.cwd());
        logger.info('SkillDiscoveryService initialized on demand');
      } catch (error) {
        logger.error('Failed to initialize SkillDiscoveryService on demand', { error });
        return {
          success: false,
          error: `Skill 系统初始化失败: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
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
