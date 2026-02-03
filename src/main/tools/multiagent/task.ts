// ============================================================================
// Task Tool - SDK-Compatible Simplified Interface for Agent Delegation
// Gen 7: Multi-Agent capability
// Wraps spawn_agent with simpler, SDK-compatible parameters
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import type { ModelConfig } from '../../../shared/types';
import { getSubagentExecutor } from '../../agent/subagentExecutor';
import {
  getPredefinedAgent,
  listPredefinedAgents,
  listPredefinedAgentIds,
  getAgentPrompt,
  getAgentTools,
  getAgentPermissionPreset,
  getAgentMaxBudget,
  getAgentDynamicMaxIterations,
  getSubagentModelConfig,
  CORE_AGENT_IDS,
  isCoreAgent,
} from '../../agent/agentDefinition';
import { taskDeduplication } from '../../agent/taskDeduplication';
import {
  SubagentContextBuilder,
  getAgentContextLevel,
} from '../../agent/subagentContextBuilder';

// ============================================================================
// P0: 参数验证与结构化输出
// 确保 task 工具参数格式正确，消除 subagent_type: undefined 错误
// ============================================================================

interface TaskParams {
  subagent_type: string;
  prompt: string;
  description?: string;
}

type TaskParamsResult =
  | { success: true; params: TaskParams }
  | { success: false; error: string };

/**
 * 解析并验证 Task 参数
 *
 * 功能：
 * 1. 提取参数（处理各种格式问题）
 * 2. 修复常见格式错误（XML 标签混入、引号包裹等）
 * 3. 验证必需参数和类型有效性
 */
function parseAndValidateTaskParams(params: Record<string, unknown>): TaskParamsResult {
  // 1. 提取 subagent_type 参数
  let subagentType = extractSubagentType(params);
  const prompt = params.prompt as string | undefined;
  const description = params.description as string | undefined;

  // 2. 修复 subagent_type 格式问题
  if (typeof subagentType === 'string') {
    // 移除可能混入的 XML/HTML 标签
    subagentType = subagentType.replace(/<[^>]*>/g, '').trim();
    // 移除首尾引号
    subagentType = subagentType.replace(/^["']|["']$/g, '');
    // 移除多余空白
    subagentType = subagentType.trim();
  }

  // 3. 验证 subagent_type
  if (!subagentType || typeof subagentType !== 'string') {
    return {
      success: false,
      error: `Missing subagent_type parameter. Valid types: ${CORE_AGENT_IDS.join(', ')}`,
    };
  }

  // 4. 检查是否为有效类型
  if (!isCoreAgent(subagentType)) {
    // 尝试模糊匹配，提供建议
    const suggestion = findSimilarAgentType(subagentType, [...CORE_AGENT_IDS]);
    const suggestionText = suggestion ? ` Did you mean "${suggestion}"?` : '';
    return {
      success: false,
      error: `Invalid subagent_type: "${subagentType}".${suggestionText} Valid types: ${CORE_AGENT_IDS.join(', ')}`,
    };
  }

  // 5. 验证 prompt
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return {
      success: false,
      error: 'Missing or empty prompt parameter',
    };
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

/**
 * 从各种可能的格式中提取 subagent_type
 */
function extractSubagentType(params: Record<string, unknown>): string | undefined {
  // 标准格式
  if (params.subagent_type && typeof params.subagent_type === 'string') {
    return params.subagent_type;
  }

  // 处理格式错误：key 中混入了值
  // 例如: { 'subagent_type="code-review</arg_value>': '...' }
  for (const key of Object.keys(params)) {
    if (key.startsWith('subagent_type')) {
      // 尝试从 key 中提取值
      const match = key.match(/subagent_type[=:]["']?([^"'<>\s]+)/);
      if (match) {
        return match[1];
      }
    }
  }

  return undefined;
}

/**
 * 模糊匹配找到相似的 agent 类型
 */
function findSimilarAgentType(input: string, validTypes: string[]): string | undefined {
  const inputLower = input.toLowerCase();

  // 精确包含匹配
  for (const type of validTypes) {
    if (type.includes(inputLower) || inputLower.includes(type)) {
      return type;
    }
  }

  // 简单编辑距离匹配（只检查首字母相同且长度接近）
  for (const type of validTypes) {
    if (type[0] === inputLower[0] && Math.abs(type.length - inputLower.length) <= 2) {
      return type;
    }
  }

  return undefined;
}

export const sdkTaskTool: Tool = {
  name: 'Task',
  description: `SDK-compatible tool for delegating tasks to specialized agents.

Use this tool when you need a single agent to complete a task synchronously.

Available agent types:
${listPredefinedAgents().map(a => `- ${a.id}: ${a.description}`).join('\n')}

For advanced features (parallel execution, background mode, custom prompts, budget control),
use AgentSpawn instead.

Parameters:
- description: Short description of the task (3-5 words)
- prompt: Detailed task for the agent
- subagent_type: Agent type to use`,
  generations: ['gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short task description (3-5 words)',
      },
      prompt: {
        type: 'string',
        description: 'Detailed task prompt',
      },
      subagent_type: {
        type: 'string',
        description: 'Agent type to use',
      },
    },
    required: ['prompt', 'subagent_type'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    // P0: 使用统一的参数验证
    const validation = parseAndValidateTaskParams(params);
    if (!validation.success) {
      return {
        success: false,
        error: validation.error,
      };
    }

    const { subagent_type: subagentType, prompt, description } = validation.params;

    // P1: 任务去重检查
    const dupCheck = taskDeduplication.isDuplicate(subagentType, prompt);
    if (dupCheck.isDuplicate) {
      if (dupCheck.cachedResult) {
        return {
          success: true,
          output: `[缓存结果] ${dupCheck.cachedResult}`,
        };
      }
      return {
        success: false,
        error: dupCheck.reason || '相同任务已在执行中，请等待完成',
      };
    }

    // P1: 注册新任务
    const taskHash = taskDeduplication.registerTask(subagentType, prompt);

    // Check for required context
    if (!context.toolRegistry || !context.modelConfig) {
      taskDeduplication.failTask(taskHash);
      return {
        success: false,
        error: 'Task requires toolRegistry and modelConfig in context',
      };
    }

    // Resolve agent configuration (已在 parseAndValidateTaskParams 中验证过类型有效性)
    const agentConfig = getPredefinedAgent(subagentType);
    if (!agentConfig) {
      // 这不应该发生，因为 parseAndValidateTaskParams 已经验证过
      taskDeduplication.failTask(taskHash);
      const availableIds = listPredefinedAgents().map(a => a.id);
      return {
        success: false,
        error: `Unknown agent type: ${subagentType}. Available: ${availableIds.join(', ')}`,
      };
    }

    const agentName = agentConfig.name;
    let systemPrompt = getAgentPrompt(agentConfig);
    const tools = getAgentTools(agentConfig);
    // P2: 使用动态迭代次数计算
    const maxIterations = getAgentDynamicMaxIterations(agentConfig, prompt);
    const permissionPreset = getAgentPermissionPreset(agentConfig);
    const maxBudget = getAgentMaxBudget(agentConfig);

    // ========================================================================
    // Phase 0: Subagent 上下文注入
    // ========================================================================
    // 借鉴 Claude Code: "Agents with access to current context can see the
    // full conversation history before the tool call"
    try {
      // 确定上下文级别：优先使用 context 中的覆盖，否则使用 Agent 类型默认值
      const contextLevel = context.contextLevel || getAgentContextLevel(subagentType);

      // 只有在有足够上下文信息时才注入
      if (context.messages && context.messages.length > 0) {
        const contextBuilder = new SubagentContextBuilder({
          sessionId: context.sessionId || 'unknown',
          messages: context.messages,
          contextLevel,
          todos: context.todos,
          modifiedFiles: context.modifiedFiles,
        });

        const subagentContext = await contextBuilder.build(prompt);
        const contextPrompt = contextBuilder.formatForSystemPrompt(subagentContext);

        if (contextPrompt) {
          systemPrompt = systemPrompt + contextPrompt;
        }
      }
    } catch (err) {
      // 上下文注入失败不应阻止任务执行
      console.warn('[Task] Failed to inject subagent context:', err);
    }

    // P4: 获取子代理专用模型配置
    const subagentModelConfig = getSubagentModelConfig(subagentType);
    const effectiveModelConfig: ModelConfig = {
      ...(context.modelConfig as ModelConfig),
      provider: subagentModelConfig.provider,
      model: subagentModelConfig.model,
    };

    try {
      const executor = getSubagentExecutor();

      // Execute synchronously (SDK-compatible behavior: always wait for completion)
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
          // P4: 使用子代理专用模型配置
          modelConfig: effectiveModelConfig,
          toolRegistry: new Map(
            context.toolRegistry.getAllTools().map((t) => [t.name, t])
          ),
          toolContext: context,
          parentToolUseId: context.currentToolCallId,
        }
      );

      if (result.success) {
        const output = `Agent [${agentName}] completed${description ? ` (${description})` : ''}:

${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}${result.cost !== undefined ? `\n- Cost: $${result.cost.toFixed(4)}` : ''}`;

        // P1: 缓存成功结果
        taskDeduplication.completeTask(taskHash, result.output);

        return {
          success: true,
          output,
        };
      } else {
        // P1: 标记任务失败
        taskDeduplication.failTask(taskHash);
        return {
          success: false,
          error: `Agent [${agentName}] failed: ${result.error}`,
          output: result.output,
        };
      }
    } catch (error) {
      // P1: 标记任务失败
      taskDeduplication.failTask(taskHash);
      return {
        success: false,
        error: `Task execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};
