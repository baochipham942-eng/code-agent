// ============================================================================
// Subagent Executor - Executes subtasks with limited tool access
// Enhanced with unified pipeline (T4)
// ============================================================================

import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';
import {
  getSubagentPipeline,
  type SubagentExecutionContext,
  type ToolExecutionRequest,
} from './subagentPipeline';
import type { AgentDefinition, DynamicAgentConfig } from './agentDefinition';
import type { PermissionPreset } from '../services/core/permissionPresets';
import { PROVIDER_REGISTRY } from '../model/modelRouter';

const logger = createLogger('SubagentExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface SubagentConfig {
  name: string;
  systemPrompt: string;
  availableTools: string[];
  maxIterations?: number;
  /** Permission preset for pipeline integration */
  permissionPreset?: PermissionPreset;
  /** Maximum budget for this subagent */
  maxBudget?: number;
}

export interface SubagentResult {
  success: boolean;
  output: string;
  error?: string;
  toolsUsed: string[];
  iterations: number;
  /** Cost incurred by this subagent */
  cost?: number;
  /** Agent ID from pipeline */
  agentId?: string;
}

interface SubagentContext {
  modelConfig: ModelConfig;
  toolRegistry: Map<string, Tool>;
  toolContext: ToolContext;
  /** Attachments (images, files) to include in the first message */
  attachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
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
   * Now integrates with SubagentPipeline for permission/budget/audit
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

    // Create pipeline context
    const pipeline = getSubagentPipeline();
    const dynamicConfig: DynamicAgentConfig = {
      name: config.name,
      systemPrompt: config.systemPrompt,
      tools: config.availableTools,
      maxIterations: config.maxIterations,
      permissionPreset: config.permissionPreset || 'development',
      maxBudget: config.maxBudget,
    };
    const pipelineContext = pipeline.createContext(
      dynamicConfig,
      context.toolContext.workingDirectory
    );

    // Filter tools to only those allowed for this subagent
    const allowedTools = this.filterTools(config.availableTools, context.toolRegistry);

    // Check if the model supports tool calls
    const providerConfig = PROVIDER_REGISTRY[context.modelConfig.provider];
    const modelInfo = providerConfig?.models.find((m: { id: string; supportsTool?: boolean }) => m.id === context.modelConfig.model);
    const supportsTool = modelInfo?.supportsTool ?? true; // Default to true if unknown

    // Only provide tool definitions if the model supports them
    const toolDefinitions = supportsTool ? allowedTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      generations: tool.generations,
      requiresPermission: tool.requiresPermission,
      permissionLevel: tool.permissionLevel,
    })) : [];

    if (!supportsTool && allowedTools.length > 0) {
      logger.warn(`[${config.name}] Model ${context.modelConfig.model} does not support tool calls, tools will be ignored`);
    }

    // MessageContent type matching modelRouter.ts
    type MessageContent = {
      type: 'text' | 'image';
      text?: string;
      source?: {
        type: 'base64';
        media_type: string;
        data: string;
      };
    };

    // Build messages with multimodal support for images
    const messages: Array<{ role: string; content: string | MessageContent[] }> = [
      { role: 'system', content: config.systemPrompt },
    ];

    // Build user message content (potentially multimodal)
    const imageAttachments = context.attachments?.filter(att => att.type === 'image') || [];
    if (imageAttachments.length > 0) {
      // Multimodal message with images
      const multimodalContent: MessageContent[] = [];

      // Add text first
      multimodalContent.push({ type: 'text', text: prompt });

      // Add images
      for (const img of imageAttachments) {
        if (img.data) {
          // Base64 data
          const mimeType = img.mimeType || 'image/png';
          multimodalContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: img.data,
            }
          });
        } else if (img.path) {
          // Load image from path
          try {
            const fs = require('fs');
            const imageData = fs.readFileSync(img.path);
            const base64 = imageData.toString('base64');
            const mimeType = img.mimeType || (img.path.endsWith('.png') ? 'image/png' : 'image/jpeg');
            multimodalContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64,
              }
            });
          } catch (err) {
            logger.warn(`[${config.name}] Failed to load image from ${img.path}:`, err);
          }
        }
      }

      messages.push({ role: 'user', content: multimodalContent });
      logger.info(`[${config.name}] Built multimodal message with ${imageAttachments.length} images`);
    } else {
      // Text-only message
      messages.push({ role: 'user', content: prompt });
    }

    logger.info(`[${config.name}] Starting with ${toolDefinitions.length} tools (agentId: ${pipelineContext.agentId}, supportsTool: ${supportsTool})`);

    try {
      // Initial budget check
      const budgetCheck = pipeline.checkBudget(pipelineContext);
      if (!budgetCheck.allowed) {
        pipeline.completeContext(pipelineContext.agentId, false, budgetCheck.reason);
        return {
          success: false,
          output: '',
          error: budgetCheck.reason,
          toolsUsed: [],
          iterations: 0,
          agentId: pipelineContext.agentId,
        };
      }

      while (iterations < maxIterations) {
        iterations++;
        logger.info(`[${config.name}] Iteration ${iterations}`);

        // Check budget before each iteration
        const iterBudgetCheck = pipeline.checkBudget(pipelineContext);
        if (!iterBudgetCheck.allowed) {
          logger.warn(`[${config.name}] Budget exceeded at iteration ${iterations}`);
          break;
        }

        // Call model
        const response = await this.modelRouter.inference(
          messages,
          toolDefinitions,
          context.modelConfig,
          () => {} // No streaming for subagents
        );

        // Note: Token usage tracking would require ModelResponse to include usage data
        // For now, we skip token usage recording as the ModelRouter doesn't expose it
        // TODO: Enhance ModelRouter to return token usage for budget tracking

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

            // Build tool execution request for pipeline
            const toolRequest: ToolExecutionRequest = {
              toolName: toolCall.name,
              permissionLevel: tool.permissionLevel,
              path: toolCall.arguments.path as string | undefined
                || toolCall.arguments.file_path as string | undefined,
              command: toolCall.arguments.command as string | undefined,
              url: toolCall.arguments.url as string | undefined,
            };

            // Check permission via pipeline
            const permCheck = pipeline.preExecutionCheck(pipelineContext, toolRequest);
            if (!permCheck.allowed) {
              toolResults.push(`Error: Permission denied for ${toolCall.name}: ${permCheck.reason}`);
              logger.warn(`[${config.name}] Tool ${toolCall.name} denied: ${permCheck.reason}`);
              continue;
            }

            // Log warnings
            for (const warning of permCheck.warnings) {
              logger.warn(`[${config.name}] Tool warning: ${warning}`);
            }

            toolsUsed.push(toolCall.name);
            pipeline.recordToolUsage(pipelineContext, toolCall.name);
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

      // Get final cost
      const budgetStatus = pipeline.getBudgetStatus(pipelineContext);
      pipeline.completeContext(pipelineContext.agentId, true);

      return {
        success: true,
        output: finalOutput || 'Subagent completed without output',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        cost: budgetStatus.subagentCost,
        agentId: pipelineContext.agentId,
      };
    } catch (error) {
      pipeline.completeContext(
        pipelineContext.agentId,
        false,
        error instanceof Error ? error.message : 'Unknown error'
      );

      return {
        success: false,
        output: '',
        error: error instanceof Error ? error.message : 'Unknown error',
        toolsUsed: [...new Set(toolsUsed)],
        iterations,
        agentId: pipelineContext.agentId,
      };
    }
  }

  /**
   * Execute from an AgentDefinition (declarative mode)
   */
  async executeFromDefinition(
    prompt: string,
    agentDef: AgentDefinition,
    context: SubagentContext
  ): Promise<SubagentResult> {
    // Convert AgentDefinition to SubagentConfig
    const config: SubagentConfig = {
      name: agentDef.name,
      systemPrompt: agentDef.systemPrompt,
      availableTools: agentDef.tools,
      maxIterations: agentDef.maxIterations || 20,
      permissionPreset: agentDef.permissionPreset,
      maxBudget: agentDef.maxBudget,
    };

    return this.execute(prompt, config, context);
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
