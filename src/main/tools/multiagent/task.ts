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
  getAgentPrompt,
  getAgentTools,
  getAgentMaxIterations,
  getAgentPermissionPreset,
  getAgentMaxBudget,
} from '../../agent/agentDefinition';

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
    const description = params.description as string | undefined;
    const prompt = params.prompt as string;
    const subagentType = params.subagent_type as string;

    // Validate required params
    if (!prompt) {
      return {
        success: false,
        error: 'prompt is required',
      };
    }

    if (!subagentType) {
      return {
        success: false,
        error: 'subagent_type is required',
      };
    }

    // Check for required context
    if (!context.toolRegistry || !context.modelConfig) {
      return {
        success: false,
        error: 'Task requires toolRegistry and modelConfig in context',
      };
    }

    // Resolve agent configuration
    const agentConfig = getPredefinedAgent(subagentType);
    if (!agentConfig) {
      const availableIds = listPredefinedAgents().map(a => a.id);
      return {
        success: false,
        error: `Unknown agent type: ${subagentType}. Available: ${availableIds.join(', ')}`,
      };
    }

    const agentName = agentConfig.name;
    const systemPrompt = getAgentPrompt(agentConfig);
    const tools = getAgentTools(agentConfig);
    const maxIterations = getAgentMaxIterations(agentConfig);
    const permissionPreset = getAgentPermissionPreset(agentConfig);
    const maxBudget = getAgentMaxBudget(agentConfig);

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
          modelConfig: context.modelConfig as ModelConfig,
          toolRegistry: new Map(
            context.toolRegistry.getAllTools().map((t) => [t.name, t])
          ),
          toolContext: context,
          parentToolUseId: context.currentToolCallId,
        }
      );

      if (result.success) {
        return {
          success: true,
          output: `Agent [${agentName}] completed${description ? ` (${description})` : ''}:

${result.output}

Stats:
- Iterations: ${result.iterations}
- Tools used: ${result.toolsUsed.join(', ') || 'none'}${result.cost !== undefined ? `\n- Cost: $${result.cost.toFixed(4)}` : ''}`,
        };
      } else {
        return {
          success: false,
          error: `Agent [${agentName}] failed: ${result.error}`,
          output: result.output,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Task execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};
