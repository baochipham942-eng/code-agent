// ============================================================================
// Subagent Executor - Executes subtasks with limited tool access
// ============================================================================

import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext, ToolExecutionResult } from '../tools/toolRegistry';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SubagentExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SubagentConfig {
  name: string;
  systemPrompt: string;
  availableTools: string[];
  maxIterations?: number;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  toolsUsed: string[];
  iterations: number;
}

interface SubagentContext {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
}

// ----------------------------------------------------------------------------
// Subagent Executor
// ----------------------------------------------------------------------------

export class SubagentExecutor {
  private modelRouter: ModelRouter;

  constructor() {
    this.modelRouter = new ModelRouter();
  }

  /**
   * Execute a subagent with a specific prompt and limited tools
   */
  async execute(
    prompt: string,
    config: SubagentConfig,
    context: SubagentContext
  ): Promise<SubagentResult> {
    const maxIterations = config.maxIterations || 10;
    const toolsUsed: string[] = [];
    let iterations = 0;
    let finalOutput = '';

    // Filter tools to only those allowed for this subagent
    const allowedTools = this.filterTools(config.availableTools, context.toolRegistry);
    const toolDefinitions = allowedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      generations: tool.generations,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    }));

    // Build messages
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: prompt },
    ];

    logger.info(`[${config.name}] Starting with ${allowedTools.length} tools`);

    try {
      while (iterations < maxIterations) {
        iterations++;
        logger.info(`[${config.name}] Iteration ${iterations}`);

        // Call model
        const response = await this.modelRouter.inference(
          messages,
          toolDefinitions,
          context.modelConfig,
          () => {} // No streaming for subagents
        );

        // Handle text response - subagent is done
        if (response.type === 'text' && response.content) {
          finalOutput = response.content;
          break;
        }

        // Handle tool calls
        if (response.type === 'tool_use' && response.toolCalls) {
          const toolResults: string[] = [];

          for (const toolCall of response.toolCalls) {
            const tool = allowedTools.find((t) => t.name === toolCall.name);
            if (!tool) {
              toolResults.push(`Error: Tool ${toolCall.name} not available`);
              continue;
            }

            toolsUsed.push(toolCall.name);
            logger.info(`[${config.name}] Executing tool: ${toolCall.name}`);

            try {
              const result = await tool.execute(toolCall.arguments, context.toolContext);
              toolResults.push(
                `Tool ${toolCall.name}: ${result.success ? 'Success' : 'Failed'}\n${result.output || result.error || ''}`
              );
            } catch (error) {
              toolResults.push(
                `Tool ${toolCall.name}: Error - ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }

          // Add tool results to messages
          messages.push({
            role: 'assistant',
            content: response.toolCalls
              .map((tc) => `Calling ${tc.name}(${JSON.stringify(tc.arguments)})`)
              .join('\n'),
          });
          messages.push({
            role: 'user',
            content: `Tool results:\n${toolResults.join('\n\n')}`,
          });

          continue;
        }

        // No response, break
        break;
      }

      return {
        success: true,
        output: finalOutput || 'Subagent completed without output',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
      };
    } catch (error) {
      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
      };
    }
  }

  private filterTools(
    allowedToolNames: string[],
    toolRegistry: Map<string, Tool>
  ): Tool[] {
    const tools: Tool[] = [];
    for (const name of allowedToolNames) {
      const tool = toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
      }
    }
    return tools;
  }
}

// Singleton instance
let subagentExecutor: SubagentExecutor | null = null;

export function getSubagentExecutor(): SubagentExecutor {
  if (!subagentExecutor) {
    subagentExecutor = new SubagentExecutor();
  }
  return subagentExecutor;
}
